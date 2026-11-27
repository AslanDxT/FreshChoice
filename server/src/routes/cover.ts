/**
 * Sickness reports and cover (shift replacement).
 *
 * Claim race: the claim is a single conditional UPDATE (status 'open' -> 'pending'), plus a
 * partial unique index allowing one 'claimed' row per request. Only one claimant can win;
 * later claimants are recorded as interested backups.
 *
 * Approval: locks the request, the schedule and both employees, re-checks every hard rule for
 * the replacement, then swaps the assignment and derives a new published version, all in one
 * transaction. The original assignment stays active until this commits.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBranchManager, requireUser, type Principal } from '../auth/principal.js';
import { db, many, one, tx, type Db, type Tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { branchManagers, emit, notify } from '../lib/events.js';
import { isoWeekday, todayLocal } from '../lib/time.js';
import { AssignmentIndex, checkCandidate } from '../scheduling/rules.js';
import type { Services } from '../services/context.js';
import { deriveVersion, loadContext, lockEmployees, lockSchedule, shiftText, loadTemplates } from '../services/schedule.js';

const uuid = z.string().uuid();
const IdParam = z.object({ id: uuid });

/** The caller's published, still-upcoming assignment. */
async function myUpcomingAssignment(c: Tx, p: Principal, assignmentId: string) {
  const a = await one(
    c,
    `SELECT a.*, s.week_start, s.published_version_id, b.name AS branch_name
       FROM shift_assignments a JOIN schedules s ON s.id = a.schedule_id JOIN branches b ON b.id = a.branch_id
      WHERE a.id = $1 AND a.user_id = $2
      FOR UPDATE OF a`,
    [assignmentId, p.id],
  );
  if (!a) throw notFound('Shift');
  const inPublished = await one(c, `SELECT 1 FROM schedule_version_assignments WHERE version_id = $1 AND assignment_id = $2 AND status = 'active'`, [a.published_version_id, a.id]);
  if (!inPublished || a.status !== 'active') throw conflict('This shift is not an active, published shift.', 'NOT_ACTIVE');
  if (new Date(a.ends_at) <= new Date()) throw conflict('This shift has already ended.', 'SHIFT_ENDED');
  return a;
}

/**
 * The role a replacement must hold. The original role is only required when losing the
 * requester would take that role below the shift's minimum; otherwise anyone eligible may
 * cover the shift as general staff.
 */
async function requiredRole(c: Db, req: any): Promise<string | null> {
  if (!req.role_skill_id) return null;
  const need = await one(
    c,
    'SELECT min_count FROM skill_requirements WHERE branch_id = $1 AND weekday = $2 AND shift_slot = $3 AND skill_id = $4',
    [req.branch_id, isoWeekday(req.work_date), req.shift_slot, req.role_skill_id],
  );
  if (!need) return null;
  const others = await one(
    c,
    `SELECT count(*)::int AS n FROM shift_assignments
      WHERE schedule_id = $1 AND work_date = $2 AND shift_slot = $3 AND status = 'active' AND role_skill_id = $4 AND id <> $5`,
    [req.schedule_id, req.work_date, req.shift_slot, req.role_skill_id, req.assignment_id ?? req.id],
  );
  return others.n >= need.min_count ? null : req.role_skill_id;
}

/**
 * Hard-rule check for every possible replacement. Offering to cover a shift is an explicit
 * statement of availability, so "not submitted" is waived for people who offer themselves
 * (mode 'self', or someone with an existing offer). A manager choosing someone who never
 * offered still needs that person's submitted availability.
 */
async function eligibleForRequest(c: Tx, req: any, userIds?: string[], mode: 'self' | 'manager' = 'self') {
  const ctx = await loadContext(c, req.branch_id, req.week_start, { scheduleId: req.schedule_id, userIds });
  const index = new AssignmentIndex([ctx.assignments, ctx.externalAssignments]);
  const role = await requiredRole(c, req);
  const offered = new Set(
    mode === 'manager' && req.id && req.assignment_id
      ? (await many(c, `SELECT claimant_id FROM cover_claims WHERE cover_request_id = $1 AND status IN ('interested', 'claimed')`, [req.id])).map((r) => r.claimant_id)
      : [],
  );
  const result = new Map<string, { code: string; message: string }[]>();
  for (const emp of ctx.employees.values()) {
    if (emp.id === req.requester_id || !emp.branchIds.includes(req.branch_id)) continue;
    let v = checkCandidate(ctx, index, { userId: emp.id, branchId: req.branch_id, date: req.work_date, slot: req.shift_slot, roleSkillId: role });
    if (mode === 'self' || offered.has(emp.id)) v = v.filter((x) => x.code !== 'AVAILABILITY_UNKNOWN');
    result.set(emp.id, v);
  }
  return result;
}

async function loadRequest(c: Tx | ReturnType<typeof db>, id: string, lock = false) {
  const r = await one(
    c,
    `SELECT cr.*, s.week_start FROM cover_requests cr JOIN schedules s ON s.id = cr.schedule_id WHERE cr.id = $1 ${lock ? 'FOR UPDATE OF cr' : ''}`,
    [id],
  );
  if (!r) throw notFound('Cover request');
  return r;
}

function describe(templates: any[], r: any) {
  return shiftText({ templates }, r.work_date, r.shift_slot);
}

export async function coverRoutes(app: FastifyInstance, _s: Services) {
  // ---------------------------------------------------------------- sickness
  app.post('/api/me/sickness', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const p = requireUser(req);
    const b = z.object({ assignmentId: uuid, includeRestOfDay: z.boolean().default(true), note: z.string().trim().max(300).optional() }).parse(req.body);
    return tx(async (c) => {
      const first = await myUpcomingAssignment(c, p, b.assignmentId);
      await lockSchedule(c, first.schedule_id);
      const targets = b.includeRestOfDay
        ? await many(
            c,
            `SELECT a.* FROM shift_assignments a JOIN schedules s ON s.id = a.schedule_id
               JOIN schedule_version_assignments x ON x.version_id = s.published_version_id AND x.assignment_id = a.id AND x.status = 'active'
              WHERE a.user_id = $1 AND a.work_date = $2 AND a.status = 'active' AND a.ends_at > now() FOR UPDATE OF a`,
            [p.id, first.work_date],
          )
        : [first];
      const report = await one(
        c,
        'INSERT INTO sickness_reports (user_id, branch_id, work_date, note) VALUES ($1, $2, $3, $4) RETURNING id',
        [p.id, first.branch_id, first.work_date, b.note || null],
      );
      const templates = await loadTemplates(c);
      const coverIds: string[] = [];
      for (const a of targets) {
        await c.query('INSERT INTO sickness_report_assignments (sickness_report_id, assignment_id) VALUES ($1, $2)', [report.id, a.id]);
        await c.query(`UPDATE shift_assignments SET status = 'sick', status_changed_by = $2, updated_at = now() WHERE id = $1`, [a.id, p.id]);
        // An open swap request for this shift is superseded by the sickness replacement request.
        const old = await many(c, `UPDATE cover_requests SET status = 'cancelled', decision_note = 'Replaced by a sickness report', claimed_by = NULL, updated_at = now()
                                  WHERE assignment_id = $1 AND status IN ('open', 'pending') RETURNING id`, [a.id]);
        for (const o of old) await c.query(`UPDATE cover_claims SET status = 'superseded', updated_at = now() WHERE cover_request_id = $1 AND status IN ('interested', 'claimed')`, [o.id]);
        const cr = await one(
          c,
          `INSERT INTO cover_requests (assignment_id, schedule_id, branch_id, requester_id, work_date, shift_slot, role_skill_id, kind, sickness_report_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'sickness', $8) RETURNING id`,
          [a.id, a.schedule_id, a.branch_id, p.id, a.work_date, a.shift_slot, a.role_skill_id, report.id],
        );
        coverIds.push(cr.id);
        await deriveVersion(
          c,
          a.schedule_id,
          'sickness',
          p.id,
          (rows) => rows.map((r) => (r.assignment_id === a.id ? { ...r, status: 'sick' } : r)),
          `${p.user.firstName} ${p.user.lastName} reported sick for ${describe(templates, a)}`,
          a.work_date,
        );
      }
      const shiftsText = targets.map((a) => describe(templates, a)).join(', ');
      await notify(c, {
        recipients: await branchManagers(c, first.branch_id),
        branchId: first.branch_id,
        type: 'sickness_reported',
        title: `${p.user.firstName} ${p.user.lastName} reported sick`,
        body: `Affected: ${shiftsText}. A replacement is needed.`,
        entityType: 'sickness_report',
        entityId: report.id,
        link: '/manage/cover?tab=sickness',
      });
      await audit(c, { actorId: p.id, action: 'sickness.reported', entityType: 'sickness_report', entityId: report.id, branchId: first.branch_id, ip: req.ip, details: { shifts: targets.length } });
      await emit(c, { t: 'sickness', b: first.branch_id });
      await emit(c, { t: 'schedule', b: first.branch_id });
      await emit(c, { t: 'cover', b: first.branch_id, all: true });
      return {
        ok: true,
        reportId: report.id,
        shifts: targets.length,
        message: `Your manager has been notified that you are sick for ${shiftsText}. You do not need to find a replacement yourself.`,
      };
    });
  });

  app.get('/api/sickness', async (req) => {
    const q = z.object({ branchId: uuid, status: z.enum(['reported', 'acknowledged', 'all']).default('all') }).parse(req.query);
    requireBranchManager(req, q.branchId);
    const rows = await many(
      db(),
      `SELECT r.id, r.user_id, r.work_date, r.note, r.status, r.reported_at, r.reviewed_at, u.first_name || ' ' || u.last_name AS name,
              rv.first_name || ' ' || rv.last_name AS reviewed_by,
              (SELECT coalesce(json_agg(json_build_object('assignmentId', a.id, 'slot', a.shift_slot,
                        'cover', (SELECT json_build_object('id', c.id, 'status', c.status) FROM cover_requests c WHERE c.assignment_id = a.id AND c.kind = 'sickness' ORDER BY c.created_at DESC LIMIT 1))
                        ORDER BY a.shift_slot), '[]')
                 FROM sickness_report_assignments sa JOIN shift_assignments a ON a.id = sa.assignment_id WHERE sa.sickness_report_id = r.id) AS shifts
         FROM sickness_reports r JOIN users u ON u.id = r.user_id LEFT JOIN users rv ON rv.id = r.reviewed_by
        WHERE r.branch_id = $1 AND ($2 = 'all' OR r.status = $2) AND r.work_date >= $3::date - 30
        ORDER BY r.work_date DESC, r.reported_at DESC LIMIT 200`,
      [q.branchId, q.status, todayLocal()],
    );
    return rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.name, date: r.work_date, note: r.note, status: r.status, reportedAt: r.reported_at, reviewedAt: r.reviewed_at, reviewedBy: r.reviewed_by, shifts: r.shifts }));
  });

  app.post('/api/sickness/:id/acknowledge', async (req) => {
    const p = requireUser(req);
    const { id } = IdParam.parse(req.params);
    await tx(async (c) => {
      const r = await one(c, 'SELECT * FROM sickness_reports WHERE id = $1 FOR UPDATE', [id]);
      if (!r || !p.canManageBranch(r.branch_id)) throw notFound('Sickness report');
      if (r.status === 'acknowledged') return;
      await c.query(`UPDATE sickness_reports SET status = 'acknowledged', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [id, p.id]);
      await c.query(`UPDATE notifications SET resolved_at = now() WHERE entity_type = 'sickness_report' AND entity_id = $1 AND resolved_at IS NULL`, [id]);
      await audit(c, { actorId: p.id, action: 'sickness.acknowledged', entityType: 'sickness_report', entityId: id, branchId: r.branch_id, ip: req.ip });
      await emit(c, { t: 'sickness', b: r.branch_id });
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ cover requests
  app.post('/api/me/cover-requests', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const p = requireUser(req);
    const b = z.object({ assignmentId: uuid, note: z.string().trim().max(300).optional() }).parse(req.body);
    return tx(async (c) => {
      const a = await myUpcomingAssignment(c, p, b.assignmentId);
      const live = await one(c, `SELECT id FROM cover_requests WHERE assignment_id = $1 AND status IN ('open', 'pending')`, [a.id]);
      if (live) throw conflict('You already asked for cover for this shift.', 'ALREADY_REQUESTED', { id: live.id });
      const cr = await one(
        c,
        `INSERT INTO cover_requests (assignment_id, schedule_id, branch_id, requester_id, work_date, shift_slot, role_skill_id, kind, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'swap', $8) RETURNING id`,
        [a.id, a.schedule_id, a.branch_id, p.id, a.work_date, a.shift_slot, a.role_skill_id, b.note || null],
      );
      const templates = await loadTemplates(c);
      const text = describe(templates, a);
      const eligible = await eligibleForRequest(c, { ...a, requester_id: p.id, week_start: a.week_start });
      const okIds = [...eligible.entries()].filter(([, v]) => !v.length).map(([id]) => id);
      await notify(c, { recipients: okIds, branchId: a.branch_id, type: 'cover_opportunity', title: `Cover needed at ${a.branch_name}`, body: text, entityType: 'cover_request', entityId: cr.id, link: '/my/cover' });
      await notify(c, {
        recipients: await branchManagers(c, a.branch_id),
        branchId: a.branch_id,
        type: 'cover_requested',
        title: `${p.user.firstName} ${p.user.lastName} asked for cover`,
        body: `${text}. ${okIds.length} colleague${okIds.length === 1 ? ' is' : 's are'} eligible.`,
        entityType: 'cover_request',
        entityId: cr.id,
        link: '/manage/cover',
      });
      await audit(c, { actorId: p.id, action: 'cover.requested', entityType: 'cover_request', entityId: cr.id, branchId: a.branch_id, ip: req.ip });
      await emit(c, { t: 'cover', b: a.branch_id, all: true });
      return { ok: true, id: cr.id, eligibleCount: okIds.length, message: `Your request is visible to ${okIds.length} eligible colleague${okIds.length === 1 ? '' : 's'}. You keep the shift until your manager approves a replacement.` };
    });
  });

  app.get('/api/me/cover-requests', async (req) => {
    const p = requireUser(req);
    const rows = await many(
      db(),
      `SELECT cr.*, b.name AS branch_name, st.start_time, st.end_time, sk.name AS role_name,
              cl.first_name AS claimed_by_name,
              (SELECT coalesce(json_agg(json_build_object('firstName', u.first_name, 'status', c.status) ORDER BY c.created_at), '[]')
                 FROM cover_claims c JOIN users u ON u.id = c.claimant_id WHERE c.cover_request_id = cr.id AND c.status IN ('interested', 'claimed', 'approved')) AS interested
         FROM cover_requests cr JOIN branches b ON b.id = cr.branch_id JOIN shift_templates st ON st.slot = cr.shift_slot
         LEFT JOIN skills sk ON sk.id = cr.role_skill_id LEFT JOIN users cl ON cl.id = cr.claimed_by
        WHERE cr.requester_id = $1 AND cr.work_date >= $2::date - 14
        ORDER BY cr.work_date DESC, cr.created_at DESC`,
      [p.id, todayLocal()],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      date: r.work_date,
      slot: r.shift_slot,
      start: r.start_time,
      end: r.end_time,
      branchName: r.branch_name,
      role: r.role_name,
      note: r.note,
      decisionNote: r.decision_note,
      claimedBy: r.claimed_by_name,
      interested: r.interested,
      createdAt: r.created_at,
    }));
  });

  /** Requests from colleagues that the caller is eligible to take. */
  app.get('/api/cover/opportunities', async (req) => {
    const p = requireUser(req);
    const branches = p.employeeBranchIds();
    if (!branches.length) return [];
    const rows = await many(
      db(),
      `SELECT cr.*, s.week_start, b.name AS branch_name, st.start_time, st.end_time, sk.name AS role_name, u.first_name AS requester_first,
              (SELECT status FROM cover_claims c WHERE c.cover_request_id = cr.id AND c.claimant_id = $2) AS my_claim
         FROM cover_requests cr JOIN schedules s ON s.id = cr.schedule_id JOIN branches b ON b.id = cr.branch_id
         JOIN shift_templates st ON st.slot = cr.shift_slot JOIN users u ON u.id = cr.requester_id
         JOIN shift_assignments a ON a.id = cr.assignment_id
         LEFT JOIN skills sk ON sk.id = cr.role_skill_id
        WHERE cr.branch_id = ANY($1::uuid[]) AND cr.status IN ('open', 'pending') AND cr.requester_id <> $2 AND a.ends_at > now()
        ORDER BY cr.work_date, cr.shift_slot`,
      [branches, p.id],
    );
    const out = [];
    for (const r of rows) {
      const elig = await tx(async (c) => eligibleForRequest(c, r, [p.id]));
      const v = elig.get(p.id) ?? [{ code: 'NOT_ELIGIBLE_BRANCH', message: 'Not eligible.' }];
      if (v.length && !r.my_claim) continue; // only show what the employee can actually take
      out.push({
        id: r.id,
        kind: r.kind,
        status: r.status,
        date: r.work_date,
        slot: r.shift_slot,
        start: r.start_time,
        end: r.end_time,
        branchName: r.branch_name,
        role: r.role_name,
        requesterFirstName: r.kind === 'sickness' ? null : r.requester_first,
        note: r.kind === 'sickness' ? null : r.note,
        myClaim: r.my_claim,
        eligible: v.length === 0,
        blockers: v.map((x) => x.message),
      });
    }
    return out;
  });

  async function claimOrInterest(req: any, mode: 'claim' | 'interest') {
    const p = requireUser(req);
    const { id } = IdParam.parse(req.params);
    return tx(async (c) => {
      const r = await loadRequest(c, id, true);
      if (!p.employeeBranchIds().includes(r.branch_id)) throw notFound('Cover request');
      if (r.requester_id === p.id) throw forbidden('You cannot take your own shift.');
      if (!['open', 'pending'].includes(r.status)) throw conflict('This cover request is no longer open.', 'NOT_OPEN');
      await lockEmployees(c, [p.id]);
      const elig = await eligibleForRequest(c, r, [p.id]);
      const v = elig.get(p.id) ?? [];
      if (v.length) throw unprocessable(`You cannot take this shift: ${v.map((x) => x.message).join(' ')}`, 'RULE_VIOLATION', { violations: v });
      // Record explicit availability if none was submitted for this shift.
      await c.query(
        `INSERT INTO availability_entries (user_id, work_date, shift_slot, status, note) VALUES ($1, $2, $3, 'available', 'Offered to cover a shift')
         ON CONFLICT (user_id, work_date, shift_slot) DO NOTHING`,
        [p.id, r.work_date, r.shift_slot],
      );
      let result: 'claimed' | 'interested' = 'interested';
      if (mode === 'claim') {
        // Atomic: only one transaction can move the request from open to pending.
        const won = await c.query(
          `UPDATE cover_requests SET status = 'pending', claimed_by = $2, claimed_at = now(), updated_at = now() WHERE id = $1 AND status = 'open'`,
          [id, p.id],
        );
        if (won.rowCount === 1) result = 'claimed';
      }
      await c.query(
        `INSERT INTO cover_claims (cover_request_id, claimant_id, status) VALUES ($1, $2, $3)
         ON CONFLICT (cover_request_id, claimant_id) DO UPDATE SET status = $3, updated_at = now()`,
        [id, p.id, result],
      );
      const templates = await loadTemplates(c);
      const text = describe(templates, r);
      if (result === 'claimed') {
        await notify(c, {
          recipients: await branchManagers(c, r.branch_id),
          branchId: r.branch_id,
          type: 'cover_awaiting_approval',
          title: `${p.user.firstName} ${p.user.lastName} offered to cover a shift`,
          body: `${text}. Waiting for your approval.`,
          entityType: 'cover_request',
          entityId: id,
          link: '/manage/cover',
        });
        if (r.kind === 'swap') {
          await notify(c, { recipients: [r.requester_id], branchId: r.branch_id, type: 'cover_claimed', title: `${p.user.firstName} offered to take your shift`, body: `${text}. Your manager still needs to approve it.`, entityType: 'cover_request', entityId: id, link: '/my/cover' });
        }
      }
      await audit(c, { actorId: p.id, action: `cover.${result}`, entityType: 'cover_request', entityId: id, branchId: r.branch_id, ip: req.ip });
      await emit(c, { t: 'cover', b: r.branch_id, all: true });
      return {
        ok: true,
        result,
        message:
          result === 'claimed'
            ? 'You offered to take this shift. Your manager will review it; you will be notified of the decision.'
            : mode === 'claim'
              ? 'Someone else claimed this shift first. You are listed as a backup in case it falls through.'
              : 'You are listed as interested. The manager can choose you if needed.',
      };
    });
  }

  app.post('/api/cover-requests/:id/claim', { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } }, (req) => claimOrInterest(req, 'claim'));
  app.post('/api/cover-requests/:id/interest', { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } }, (req) => claimOrInterest(req, 'interest'));

  app.post('/api/cover-requests/:id/withdraw', async (req) => {
    const p = requireUser(req);
    const { id } = IdParam.parse(req.params);
    return tx(async (c) => {
      const r = await loadRequest(c, id, true);
      const claim = await one(c, `SELECT * FROM cover_claims WHERE cover_request_id = $1 AND claimant_id = $2 AND status IN ('interested', 'claimed') FOR UPDATE`, [id, p.id]);
      if (!claim) throw notFound('Claim');
      await c.query(`UPDATE cover_claims SET status = 'withdrawn', updated_at = now() WHERE id = $1`, [claim.id]);
      if (r.status === 'pending' && r.claimed_by === p.id) {
        await c.query(`UPDATE cover_requests SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = now() WHERE id = $1`, [id]);
        await notify(c, { recipients: await branchManagers(c, r.branch_id), branchId: r.branch_id, type: 'cover_claim_withdrawn', title: `${p.user.firstName} ${p.user.lastName} withdrew a cover offer`, entityType: 'cover_request', entityId: id, link: '/manage/cover' });
      }
      await audit(c, { actorId: p.id, action: 'cover.withdrawn', entityType: 'cover_request', entityId: id, branchId: r.branch_id, ip: req.ip });
      await emit(c, { t: 'cover', b: r.branch_id, all: true });
      return { ok: true };
    });
  });

  app.post('/api/cover-requests/:id/cancel', async (req) => {
    const p = requireUser(req);
    const { id } = IdParam.parse(req.params);
    return tx(async (c) => {
      const r = await loadRequest(c, id, true);
      if (r.requester_id !== p.id) throw notFound('Cover request');
      if (r.kind === 'sickness') throw forbidden('A sickness replacement is handled by your manager.');
      if (!['open', 'pending'].includes(r.status)) throw conflict('This request can no longer be cancelled.', 'NOT_OPEN');
      await c.query(`UPDATE cover_requests SET status = 'cancelled', claimed_by = NULL, decision_note = 'Cancelled by the requester', updated_at = now() WHERE id = $1`, [id]);
      const claimants = await many(c, `UPDATE cover_claims SET status = 'superseded', updated_at = now() WHERE cover_request_id = $1 AND status IN ('interested', 'claimed') RETURNING claimant_id`, [id]);
      await notify(c, { recipients: claimants.map((x) => x.claimant_id), branchId: r.branch_id, type: 'cover_cancelled', title: 'A cover request you responded to was cancelled', entityType: 'cover_request', entityId: id, link: '/my/cover' });
      await c.query(`UPDATE notifications SET resolved_at = now() WHERE entity_type = 'cover_request' AND entity_id = $1 AND resolved_at IS NULL`, [id]);
      await audit(c, { actorId: p.id, action: 'cover.cancelled', entityType: 'cover_request', entityId: id, branchId: r.branch_id, ip: req.ip });
      await emit(c, { t: 'cover', b: r.branch_id, all: true });
      return { ok: true };
    });
  });

  // --------------------------------------------------------- manager actions
  app.get('/api/cover-requests', async (req) => {
    const q = z.object({ branchId: uuid, status: z.enum(['active', 'all']).default('active') }).parse(req.query);
    requireBranchManager(req, q.branchId);
    const rows = await many(
      db(),
      `SELECT cr.*, s.week_start, st.start_time, st.end_time, sk.name AS role_name, u.first_name || ' ' || u.last_name AS requester_name,
              d.first_name || ' ' || d.last_name AS decided_by_name,
              (SELECT coalesce(json_agg(json_build_object('userId', c.claimant_id, 'name', cu.first_name || ' ' || cu.last_name, 'status', c.status, 'at', c.updated_at) ORDER BY c.created_at), '[]')
                 FROM cover_claims c JOIN users cu ON cu.id = c.claimant_id WHERE c.cover_request_id = cr.id) AS claims,
              ra.user_id AS replacement_user_id, rau.first_name || ' ' || rau.last_name AS replacement_name
         FROM cover_requests cr JOIN schedules s ON s.id = cr.schedule_id JOIN shift_templates st ON st.slot = cr.shift_slot
         JOIN users u ON u.id = cr.requester_id LEFT JOIN users d ON d.id = cr.decided_by LEFT JOIN skills sk ON sk.id = cr.role_skill_id
         LEFT JOIN shift_assignments ra ON ra.id = cr.replacement_assignment_id LEFT JOIN users rau ON rau.id = ra.user_id
        WHERE cr.branch_id = $1 AND ($2 = 'all' OR cr.status IN ('open', 'pending')) AND cr.work_date >= $3::date - 30
        ORDER BY (cr.status IN ('pending', 'open')) DESC, cr.work_date, cr.shift_slot LIMIT 300`,
      [q.branchId, q.status, todayLocal()],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      date: r.work_date,
      slot: r.shift_slot,
      start: r.start_time,
      end: r.end_time,
      role: r.role_name,
      roleSkillId: r.role_skill_id,
      weekStart: r.week_start,
      requesterId: r.requester_id,
      requesterName: r.requester_name,
      note: r.note,
      claimedBy: r.claimed_by,
      claims: r.claims,
      decidedBy: r.decided_by_name,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      replacement: r.replacement_user_id ? { userId: r.replacement_user_id, name: r.replacement_name } : null,
      createdAt: r.created_at,
    }));
  });

  /** Eligible replacements for a request, with reasons for everyone else. */
  app.get('/api/cover-requests/:id/candidates', async (req) => {
    const p = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const r = await loadRequest(db(), id);
    if (!p.canManageBranch(r.branch_id)) throw notFound('Cover request');
    const elig = await tx(async (c) => eligibleForRequest(c, r, undefined, 'manager'));
    const names = await many(db(), 'SELECT id, first_name || \' \' || last_name AS name FROM users WHERE id = ANY($1::uuid[])', [[...elig.keys()]]);
    return [...elig.entries()]
      .map(([userId, v]) => ({ userId, name: names.find((n) => n.id === userId)?.name ?? '', eligible: v.length === 0, reasons: v.map((x) => x.message) }))
      .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.name.localeCompare(b.name));
  });

  app.post('/api/cover-requests/:id/approve', async (req) => {
    const p = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const b = z.object({ userId: uuid }).parse(req.body);
    return tx(async (c) => {
      const r = await loadRequest(c, id, true);
      if (!p.canManageBranch(r.branch_id)) throw notFound('Cover request');
      if (!['open', 'pending'].includes(r.status)) throw conflict('This request has already been decided.', 'NOT_OPEN');
      await lockSchedule(c, r.schedule_id);
      await lockEmployees(c, [r.requester_id, b.userId]);
      const original = await one(c, 'SELECT * FROM shift_assignments WHERE id = $1 FOR UPDATE', [r.assignment_id]);
      if (new Date(original.ends_at) <= new Date()) throw conflict('This shift has already ended.', 'SHIFT_ENDED');
      const expected = r.kind === 'swap' ? 'active' : 'sick';
      if (original.status !== expected) throw conflict('The original shift changed in the meantime. Reload and try again.', 'STALE');
      const elig = await eligibleForRequest(c, r, [b.userId], 'manager');
      const v = elig.get(b.userId) ?? [{ code: 'NOT_ELIGIBLE_BRANCH', message: 'Not eligible for this branch.' }];
      if (v.length) throw unprocessable(`This employee cannot take the shift: ${v.map((x) => x.message).join(' ')}`, 'RULE_VIOLATION', { violations: v });
      await c.query(
        `INSERT INTO availability_entries (user_id, work_date, shift_slot, status, note) VALUES ($1, $2, $3, 'available', 'Assigned through cover')
         ON CONFLICT (user_id, work_date, shift_slot) DO NOTHING`,
        [b.userId, r.work_date, r.shift_slot],
      );
      // Keep the original role when the replacement holds it; otherwise they work as general
      // staff (eligibility already required the role if coverage depended on it).
      let newRole: string | null = await requiredRole(c, r);
      if (!newRole && original.role_skill_id) {
        const holds = await one(
          c,
          `SELECT 1 FROM employee_skills WHERE user_id = $1 AND skill_id = $2 AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until >= $3)`,
          [b.userId, original.role_skill_id, original.work_date],
        );
        if (holds) newRole = original.role_skill_id;
      }
      if (r.kind === 'swap') {
        await c.query(`UPDATE shift_assignments SET status = 'replaced', status_changed_by = $2, updated_at = now() WHERE id = $1`, [original.id, p.id]);
      }
      const created = await one(
        c,
        `INSERT INTO shift_assignments (shift_id, schedule_id, branch_id, user_id, work_date, shift_slot, starts_at, ends_at, role_skill_id, source, replaces_assignment_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'cover',$10,$11) RETURNING id`,
        [original.shift_id, original.schedule_id, original.branch_id, b.userId, original.work_date, original.shift_slot, original.starts_at, original.ends_at, newRole, original.id, p.id],
      );
      await c.query(
        `UPDATE cover_requests SET status = 'approved', claimed_by = coalesce(claimed_by, $2), decided_by = $3, decided_at = now(),
                replacement_assignment_id = $4, updated_at = now() WHERE id = $1`,
        [id, b.userId, p.id, created.id],
      );
      await c.query(
        `INSERT INTO cover_claims (cover_request_id, claimant_id, status) VALUES ($1, $2, 'approved')
         ON CONFLICT (cover_request_id, claimant_id) DO UPDATE SET status = 'approved', updated_at = now()`,
        [id, b.userId],
      );
      const others = await many(
        c,
        `UPDATE cover_claims SET status = 'superseded', updated_at = now() WHERE cover_request_id = $1 AND claimant_id <> $2 AND status IN ('interested', 'claimed') RETURNING claimant_id`,
        [id, b.userId],
      );
      await c.query(
        `INSERT INTO replacement_history (cover_request_id, original_assignment_id, replacement_assignment_id, original_user_id, replacement_user_id, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, original.id, created.id, original.user_id, b.userId, p.id],
      );
      const st = await one(c, 'SELECT start_time, end_time FROM shift_templates WHERE slot = $1', [original.shift_slot]);
      const replacement = await one(c, `SELECT first_name || ' ' || last_name AS name FROM users WHERE id = $1`, [b.userId]);
      await deriveVersion(
        c,
        original.schedule_id,
        'cover',
        p.id,
        (rows) => [
          ...rows.map((x) => (x.assignment_id === original.id && r.kind === 'swap' ? { ...x, status: 'replaced' as const } : x)),
          {
            assignment_id: created.id,
            user_id: b.userId,
            work_date: original.work_date,
            shift_slot: original.shift_slot,
            starts_at: original.starts_at,
            ends_at: original.ends_at,
            role_skill_id: newRole,
            status: 'active',
          },
        ],
        `Cover approved: ${replacement.name} replaces the original employee`,
        original.work_date,
      );
      const templates = await loadTemplates(c);
      const text = describe(templates, r);
      await notify(c, { recipients: [b.userId], branchId: r.branch_id, type: 'cover_approved', title: 'You are now scheduled for an extra shift', body: `${text} (${st.start_time}–${st.end_time}).`, entityType: 'cover_request', entityId: id, link: '/my/schedule' });
      await notify(c, {
        recipients: [r.requester_id],
        branchId: r.branch_id,
        type: 'cover_approved',
        title: r.kind === 'swap' ? 'Your cover request was approved' : 'A replacement was found for your shift',
        body: `${replacement.name} takes ${text}.${r.kind === 'swap' ? ' You are no longer scheduled for it.' : ''}`,
        entityType: 'cover_request',
        entityId: id,
        link: '/my/cover',
      });
      await notify(c, { recipients: others.map((o) => o.claimant_id), branchId: r.branch_id, type: 'cover_filled', title: 'A shift you offered to cover was filled', body: text, entityType: 'cover_request', entityId: id, link: '/my/cover' });
      await c.query(`UPDATE notifications SET resolved_at = now() WHERE entity_type = 'cover_request' AND entity_id = $1 AND resolved_at IS NULL AND type IN ('cover_requested', 'cover_awaiting_approval', 'cover_opportunity')`, [id]);
      await audit(c, { actorId: p.id, action: 'cover.approved', entityType: 'cover_request', entityId: id, branchId: r.branch_id, ip: req.ip, details: { replacement: b.userId, kind: r.kind } });
      await emit(c, { t: 'cover', b: r.branch_id, all: true });
      await emit(c, { t: 'schedule', b: r.branch_id, all: true });
      return { ok: true, replacementAssignmentId: created.id };
    });
  });

  app.post('/api/cover-requests/:id/reject-claim', async (req) => {
    const p = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const b = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    return tx(async (c) => {
      const r = await loadRequest(c, id, true);
      if (!p.canManageBranch(r.branch_id)) throw notFound('Cover request');
      if (r.status !== 'pending') throw conflict('There is no pending claim to reject.', 'NOT_PENDING');
      await c.query(`UPDATE cover_claims SET status = 'rejected', updated_at = now() WHERE cover_request_id = $1 AND claimant_id = $2`, [id, r.claimed_by]);
      await c.query(`UPDATE cover_requests SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = now() WHERE id = $1`, [id]);
      const templates = await loadTemplates(c);
      await notify(c, { recipients: [r.claimed_by], branchId: r.branch_id, type: 'cover_claim_rejected', title: 'Your offer to cover a shift was not accepted', body: `${describe(templates, r)}${b.note ? `. ${b.note}` : ''}`, entityType: 'cover_request', entityId: id, link: '/my/cover' });
      await audit(c, { actorId: p.id, action: 'cover.claim_rejected', entityType: 'cover_request', entityId: id, branchId: r.branch_id, ip: req.ip });
      await emit(c, { t: 'cover', b: r.branch_id, all: true });
      return { ok: true };
    });
  });

  app.post('/api/cover-requests/:id/reject', async (req) => {
    const p = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const b = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    return tx(async (c) => {
      const r = await loadRequest(c, id, true);
      if (!p.canManageBranch(r.branch_id)) throw notFound('Cover request');
      if (!['open', 'pending'].includes(r.status)) throw conflict('This request has already been decided.', 'NOT_OPEN');
      // A sickness replacement cannot be "rejected" (the employee is sick); it can be closed.
      const status = r.kind === 'sickness' ? 'cancelled' : 'rejected';
      await c.query(
        `UPDATE cover_requests SET status = $2, claimed_by = NULL, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now() WHERE id = $1`,
        [id, status, p.id, b.note || (r.kind === 'sickness' ? 'Closed by the manager without a replacement' : null)],
      );
      const claimants = await many(c, `UPDATE cover_claims SET status = 'superseded', updated_at = now() WHERE cover_request_id = $1 AND status IN ('interested', 'claimed') RETURNING claimant_id`, [id]);
      const templates = await loadTemplates(c);
      const text = describe(templates, r);
      if (r.kind === 'swap') {
        await notify(c, { recipients: [r.requester_id], branchId: r.branch_id, type: 'cover_rejected', title: 'Your cover request was declined', body: `${text}. You remain scheduled for this shift.${b.note ? ` ${b.note}` : ''}`, entityType: 'cover_request', entityId: id, link: '/my/cover' });
      }
      await notify(c, { recipients: claimants.map((x) => x.claimant_id), branchId: r.branch_id, type: 'cover_cancelled', title: 'A cover request you responded to was closed', body: text, entityType: 'cover_request', entityId: id, link: '/my/cover' });
      await c.query(`UPDATE notifications SET resolved_at = now() WHERE entity_type = 'cover_request' AND entity_id = $1 AND resolved_at IS NULL`, [id]);
      await audit(c, { actorId: p.id, action: `cover.${status}`, entityType: 'cover_request', entityId: id, branchId: r.branch_id, ip: req.ip });
      await emit(c, { t: 'cover', b: r.branch_id, all: true });
      return { ok: true, status };
    });
  });
}

