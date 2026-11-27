import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireBranchManager, requireUser } from '../auth/principal.js';
import { db, many, one, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { emit } from '../lib/events.js';
import { isDate, localTimeOf, monthRange, weekStartOf } from '../lib/time.js';
import { listCandidates } from '../scheduling/generate.js';
import { validateSchedule } from '../scheduling/validate.js';
import type { Services } from '../services/context.js';
import {
  addAssignment,
  generate,
  getOrCreateSchedule,
  loadContext,
  monthView,
  publish,
  removeAssignment,
  updateAssignment,
  weekView,
} from '../services/schedule.js';

const uuid = z.string().uuid();
const dateStr = z.string().refine(isDate, 'Use YYYY-MM-DD');
const weekStr = dateStr.refine((d) => weekStartOf(d) === d, 'A week starts on Monday');
const BranchWeek = z.object({ branchId: uuid, weekStart: weekStr });

async function scheduleForManager(req: any, scheduleId: string) {
  const s = await one(db(), 'SELECT * FROM schedules WHERE id = $1', [scheduleId]);
  if (!s || !req.principal?.canManageBranch(s.branch_id)) throw notFound('Schedule');
  return s;
}

export async function scheduleRoutes(app: FastifyInstance, _s: Services) {
  app.get('/api/branches/:branchId/weeks/:weekStart', async (req) => {
    const { branchId, weekStart } = BranchWeek.parse(req.params);
    requireBranchManager(req, branchId);
    return weekView(db(), branchId, weekStart);
  });

  app.get('/api/branches/:branchId/month', async (req) => {
    const { branchId } = z.object({ branchId: uuid }).parse(req.params);
    const { month } = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(req.query);
    requireBranchManager(req, branchId);
    const { from, to } = monthRange(month);
    return monthView(db(), branchId, from, to);
  });

  app.get('/api/branches/:branchId/weeks/:weekStart/candidates', async (req) => {
    const { branchId, weekStart } = BranchWeek.parse(req.params);
    requireBranchManager(req, branchId);
    const q = z.object({ date: dateStr, slot: z.coerce.number().int().min(1).max(4), roleSkillId: uuid.optional() }).parse(req.query);
    const s = await one(db(), 'SELECT id FROM schedules WHERE branch_id = $1 AND week_start = $2', [branchId, weekStart]);
    const ctx = await loadContext(db(), branchId, weekStart, { scheduleId: s?.id ?? null });
    return listCandidates(ctx, q.date, q.slot, q.roleSkillId ?? null);
  });

  app.post('/api/branches/:branchId/weeks/:weekStart/assignments', async (req) => {
    const { branchId, weekStart } = BranchWeek.parse(req.params);
    const p = requireBranchManager(req, branchId);
    const body = z.object({ userId: uuid, date: dateStr, slot: z.number().int().min(1).max(4), roleSkillId: uuid.nullable().default(null) }).parse(req.body);
    return tx((c) => addAssignment(c, p, branchId, weekStart, body, req.ip));
  });

  app.patch('/api/assignments/:id', async (req) => {
    const p = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({ userId: uuid.optional(), date: dateStr.optional(), slot: z.number().int().min(1).max(4).optional(), roleSkillId: uuid.nullable().optional() })
      .parse(req.body);
    if (!Object.keys(body).length) throw badRequest('Nothing to change.');
    return tx((c) => updateAssignment(c, p, id, body, req.ip));
  });

  app.delete('/api/assignments/:id', async (req) => {
    const p = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return tx((c) => removeAssignment(c, p, id, req.ip));
  });

  app.post('/api/branches/:branchId/weeks/:weekStart/generate', async (req) => {
    const { branchId, weekStart } = BranchWeek.parse(req.params);
    const p = requireBranchManager(req, branchId);
    const { mode } = z.object({ mode: z.enum(['fill', 'replace']).default('fill') }).parse(req.body ?? {});
    return tx((c) => generate(c, p, branchId, weekStart, mode, req.ip));
  });

  app.put('/api/branches/:branchId/weeks/:weekStart/settings', async (req) => {
    const { branchId, weekStart } = BranchWeek.parse(req.params);
    const p = requireBranchManager(req, branchId);
    const body = z.object({ availabilityDeadline: dateStr.nullable() }).parse(req.body);
    if (body.availabilityDeadline && body.availabilityDeadline >= weekStart) throw badRequest('The availability deadline must be before the week starts.');
    return tx(async (c) => {
      const s = await getOrCreateSchedule(c, branchId, weekStart, p.id);
      await c.query('UPDATE schedules SET availability_deadline = $2, updated_at = now() WHERE id = $1', [s.id, body.availabilityDeadline]);
      await audit(c, { actorId: p.id, action: 'schedule.deadline_set', entityType: 'schedule', entityId: s.id, branchId, ip: req.ip, details: body });
      await emit(c, { t: 'schedule', b: branchId, all: true });
      return { ok: true };
    });
  });

  app.post('/api/schedules/:id/validate', async (req) => {
    const p = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const s = await scheduleForManager(req, id);
    const ctx = await loadContext(db(), s.branch_id, s.week_start, { scheduleId: id });
    const result = validateSchedule(ctx);
    await tx(async (c) => {
      const run = await one(
        c,
        `INSERT INTO scheduling_runs (schedule_id, kind, policy_version_id, schedule_revision, error_count, warning_count, started_by, finished_at)
         VALUES ($1, 'validate', $2, $3, $4, $5, $6, now()) RETURNING id`,
        [id, ctx.policy.versionId, s.revision, result.issues.filter((i) => i.severity === 'error').length, result.issues.filter((i) => i.severity === 'warning').length, p.id],
      );
      for (const i of result.issues) {
        await c.query(
          `INSERT INTO scheduling_run_issues (run_id, severity, code, work_date, shift_slot, user_id, skill_id, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [run.id, i.severity, i.code, i.date ?? null, i.slot ?? null, i.userId ?? null, i.skillId ?? null, i.message],
        );
      }
    });
    // Also report if the published version would fail under the *current* policy.
    let policyNote: string | null = null;
    if (s.published_version_id) {
      const v = await one(db(), 'SELECT policy_version_id FROM schedule_versions WHERE id = $1', [s.published_version_id]);
      if (v && v.policy_version_id !== ctx.policy.versionId) {
        policyNote = 'The published version was validated under an earlier scheduling policy. The results above use the current policy.';
      }
    }
    return { revision: s.revision, issues: result.issues, coverage: result.coverage, policyNote };
  });

  app.post('/api/schedules/:id/publish', async (req) => {
    const p = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { revision } = z.object({ revision: z.number().int().min(0) }).parse(req.body);
    await scheduleForManager(req, id);
    return tx((c) => publish(c, p, id, revision, req.ip));
  });

  app.get('/api/schedules/:id/versions', async (req) => {
    requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await scheduleForManager(req, id);
    const rows = await many(
      db(),
      `SELECT v.id, v.version_no, v.reason, v.change_summary, v.created_at, v.policy_version_id, u.first_name || ' ' || u.last_name AS created_by,
              (SELECT count(*)::int FROM schedule_version_assignments x WHERE x.version_id = v.id AND x.status = 'active') AS shifts
         FROM schedule_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.schedule_id = $1 ORDER BY v.version_no DESC`,
      [id],
    );
    return rows.map((r) => ({ id: r.id, versionNo: r.version_no, reason: r.reason, summary: r.change_summary, createdAt: r.created_at, createdBy: r.created_by, policyVersionId: r.policy_version_id, shifts: r.shifts }));
  });

  app.get('/api/schedule-versions/:id', async (req) => {
    requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const v = await one(db(), 'SELECT * FROM schedule_versions WHERE id = $1', [id]);
    if (!v) throw notFound('Version');
    await scheduleForManager(req, v.schedule_id);
    const rows = await many(
      db(),
      `SELECT x.*, u.first_name || ' ' || u.last_name AS name FROM schedule_version_assignments x JOIN users u ON u.id = x.user_id
        WHERE x.version_id = $1 ORDER BY x.work_date, x.shift_slot, name`,
      [id],
    );
    const prev = await one(db(), 'SELECT id FROM schedule_versions WHERE schedule_id = $1 AND version_no = $2', [v.schedule_id, v.version_no - 1]);
    const prevRows = prev ? await many(db(), 'SELECT user_id, work_date, shift_slot, role_skill_id, status FROM schedule_version_assignments WHERE version_id = $1', [prev.id]) : [];
    const key = (r: any) => `${r.user_id}|${r.work_date}|${r.shift_slot}`;
    const prevActive = new Set(prevRows.filter((r) => r.status === 'active').map(key));
    const nowActive = new Set(rows.filter((r) => r.status === 'active').map(key));
    return {
      id: v.id,
      versionNo: v.version_no,
      reason: v.reason,
      summary: v.change_summary,
      createdAt: v.created_at,
      assignments: rows.map((r) => ({
        userId: r.user_id,
        name: r.name,
        date: r.work_date,
        slot: r.shift_slot,
        roleSkillId: r.role_skill_id,
        status: r.status,
        change: r.status === 'active' && !prevActive.has(key(r)) && prev ? 'added' : null,
      })),
      removed: prevRows
        .filter((r) => r.status === 'active' && !nowActive.has(key(r)))
        .map((r) => ({ userId: r.user_id, date: r.work_date, slot: r.shift_slot })),
    };
  });

  app.get('/api/branches/:branchId/history', async (req) => {
    const { branchId } = z.object({ branchId: uuid }).parse(req.params);
    requireBranchManager(req, branchId);
    const rows = await many(
      db(),
      `SELECT s.id, s.week_start, s.status, s.revision, s.published_revision,
              (SELECT count(*)::int FROM schedule_versions v WHERE v.schedule_id = s.id) AS versions,
              (SELECT max(created_at) FROM schedule_versions v WHERE v.schedule_id = s.id) AS last_published,
              (SELECT json_build_object('kind', r.kind, 'errors', r.error_count, 'warnings', r.warning_count, 'at', r.started_at)
                 FROM scheduling_runs r WHERE r.schedule_id = s.id ORDER BY r.started_at DESC LIMIT 1) AS last_run
         FROM schedules s WHERE s.branch_id = $1 ORDER BY s.week_start DESC LIMIT 104`,
      [branchId],
    );
    return rows.map((r) => ({
      id: r.id,
      weekStart: r.week_start,
      status: r.status,
      hasUnpublishedChanges: r.status === 'draft' || r.revision !== r.published_revision,
      versions: r.versions,
      lastPublished: r.last_published,
      lastRun: r.last_run,
    }));
  });

  // ------------------------------------------------------------ employee view
  app.get('/api/me/shifts', async (req) => {
    const p = requireUser(req);
    const q = z.object({ from: dateStr, to: dateStr }).parse(req.query);
    if (q.to < q.from) throw badRequest('The end date is before the start date.');
    const rows = await many(
      db(),
      `SELECT x.assignment_id, x.work_date, x.shift_slot, x.status, x.role_skill_id, sk.name AS role_name, b.id AS branch_id, b.name AS branch_name,
              st.start_time, st.end_time, s.id AS schedule_id,
              cr.id AS cover_id, cr.status AS cover_status, cr.kind AS cover_kind
         FROM schedules s
         JOIN schedule_version_assignments x ON x.version_id = s.published_version_id
         JOIN branches b ON b.id = s.branch_id
         JOIN shift_templates st ON st.slot = x.shift_slot
         LEFT JOIN skills sk ON sk.id = x.role_skill_id
         LEFT JOIN LATERAL (SELECT id, status, kind FROM cover_requests c WHERE c.assignment_id = x.assignment_id ORDER BY created_at DESC LIMIT 1) cr ON true
        WHERE x.user_id = $1 AND x.work_date BETWEEN $2 AND $3
        ORDER BY x.work_date, x.shift_slot`,
      [p.id, q.from, q.to],
    );
    const breaks = await many(
      db(),
      `SELECT b.work_date, b.starts_at, b.ends_at, b.minutes FROM schedules s JOIN schedule_version_breaks b ON b.version_id = s.published_version_id
        WHERE b.user_id = $1 AND b.work_date BETWEEN $2 AND $3`,
      [p.id, q.from, q.to],
    );
    return {
      shifts: rows.map((r) => ({
        assignmentId: r.assignment_id,
        date: r.work_date,
        slot: r.shift_slot,
        start: r.start_time,
        end: r.end_time,
        status: r.status,
        role: r.role_name,
        branchId: r.branch_id,
        branchName: r.branch_name,
        cover: r.cover_id ? { id: r.cover_id, status: r.cover_status, kind: r.cover_kind } : null,
      })),
      breaks: breaks.map((b) => ({ date: b.work_date, start: localTimeOf(new Date(b.starts_at).getTime()), end: localTimeOf(new Date(b.ends_at).getTime()), minutes: b.minutes })),
    };
  });
}
