import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertCanManageEmployee, requireBranchManager, requireUser } from '../auth/principal.js';
import { db, many, one, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, unprocessable } from '../lib/errors.js';
import { branchManagers, emit, notify } from '../lib/events.js';
import { addDays, daysBetween, isDate, monthRange, todayLocal, weekStartOf } from '../lib/time.js';
import { fmtDate } from '../scheduling/rules.js';
import type { Services } from '../services/context.js';

const uuid = z.string().uuid();
const dateStr = z.string().refine(isDate, 'Use YYYY-MM-DD');

export async function availabilityRoutes(app: FastifyInstance, _s: Services) {
  app.get('/api/me/availability', async (req) => {
    const p = requireUser(req);
    const q = z.object({ from: dateStr, to: dateStr }).parse(req.query);
    if (q.to < q.from || daysBetween(q.from, q.to) > 62) throw badRequest('Choose a range of at most two months.');
    const entries = await many(
      db(),
      'SELECT work_date, shift_slot, status, note, updated_at FROM availability_entries WHERE user_id = $1 AND work_date BETWEEN $2 AND $3',
      [p.id, q.from, q.to],
    );
    // Confirmed (published) assignments, shown green.
    const assigned = await many(
      db(),
      `SELECT x.assignment_id, x.work_date, x.shift_slot, x.status, b.name AS branch_name,
              (SELECT c.status FROM cover_requests c WHERE c.assignment_id = x.assignment_id ORDER BY c.created_at DESC LIMIT 1) AS cover_status
         FROM schedules s
         JOIN schedule_version_assignments x ON x.version_id = s.published_version_id JOIN branches b ON b.id = s.branch_id
        WHERE x.user_id = $1 AND x.work_date BETWEEN $2 AND $3`,
      [p.id, q.from, q.to],
    );
    const deadlines = await many(
      db(),
      `SELECT s.week_start, s.availability_deadline, b.name AS branch_name FROM schedules s JOIN branches b ON b.id = s.branch_id
        WHERE s.branch_id = ANY($1::uuid[]) AND s.availability_deadline IS NOT NULL AND s.week_start BETWEEN $2 AND $3`,
      [p.employeeBranchIds(), weekStartOf(q.from), q.to],
    );
    const submissions = await many(
      db(),
      'SELECT period_type, start_date, end_date, submitted_at, entry_count FROM availability_submissions WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 10',
      [p.id],
    );
    return {
      today: todayLocal(),
      entries: entries.map((e) => ({ date: e.work_date, slot: e.shift_slot, status: e.status, note: e.note, updatedAt: e.updated_at })),
      assigned: assigned.map((a) => ({ assignmentId: a.assignment_id, date: a.work_date, slot: a.shift_slot, status: a.status, branchName: a.branch_name, coverStatus: a.cover_status })),
      deadlines: deadlines.map((d) => ({ weekStart: d.week_start, deadline: d.availability_deadline, branchName: d.branch_name })),
      submissions: submissions.map((s) => ({ periodType: s.period_type, startDate: s.start_date, endDate: s.end_date, submittedAt: s.submitted_at, entryCount: s.entry_count })),
    };
  });

  app.post('/api/me/availability', { config: { rateLimit: { max: 60, timeWindow: '15 minutes' } } }, async (req) => {
    const p = requireUser(req);
    const b = z
      .object({
        periodType: z.enum(['week', 'month']),
        startDate: dateStr,
        entries: z
          .array(z.object({ date: dateStr, slot: z.number().int().min(1).max(4), status: z.enum(['available', 'unavailable']), note: z.string().trim().max(200).optional() }))
          .min(1)
          .max(31 * 4),
      })
      .parse(req.body);
    if (!p.employeeBranchIds().length) throw badRequest('Your account is not set up to be scheduled at a branch.');
    let endDate: string;
    if (b.periodType === 'week') {
      if (weekStartOf(b.startDate) !== b.startDate) throw badRequest('A weekly period starts on a Monday.');
      endDate = addDays(b.startDate, 6);
    } else {
      const r = monthRange(b.startDate.slice(0, 7));
      if (r.from !== b.startDate) throw badRequest('A monthly period starts on the first day of the month.');
      endDate = r.to;
    }
    const today = todayLocal();
    const keys = new Set<string>();
    for (const e of b.entries) {
      if (e.date < b.startDate || e.date > endDate) throw badRequest(`${e.date} is outside the selected period.`);
      if (e.date < today) throw badRequest('Availability for past days cannot be changed.');
      const k = `${e.date}:${e.slot}`;
      if (keys.has(k)) throw badRequest('Each shift can only appear once.');
      keys.add(k);
    }

    return tx(async (c) => {
      // Confirmed shifts must go through Call Sick or Find Cover instead of availability.
      const published = await many(
        c,
        `SELECT x.work_date, x.shift_slot FROM schedules s JOIN schedule_version_assignments x ON x.version_id = s.published_version_id
          WHERE x.user_id = $1 AND x.status = 'active' AND x.work_date BETWEEN $2 AND $3`,
        [p.id, b.startDate, endDate],
      );
      const blocked = b.entries.filter((e) => e.status === 'unavailable' && published.some((x) => x.work_date === e.date && x.shift_slot === e.slot));
      if (blocked.length) {
        throw unprocessable(
          `You are already scheduled for ${blocked.map((e) => fmtDate(e.date)).join(', ')}. Use Call Sick or Find Cover for confirmed shifts.`,
          'ASSIGNED_SHIFT',
          { shifts: blocked.map((e) => ({ date: e.date, slot: e.slot })) },
        );
      }
      const existing = await many(c, 'SELECT work_date, shift_slot, status FROM availability_entries WHERE user_id = $1 AND work_date BETWEEN $2 AND $3 FOR UPDATE', [p.id, b.startDate, endDate]);
      const sub = await one(
        c,
        `INSERT INTO availability_submissions (user_id, period_type, start_date, end_date, entry_count) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [p.id, b.periodType, b.startDate, endDate, b.entries.length],
      );
      const withdrawn: { date: string; slot: number }[] = [];
      let changed = 0;
      for (const e of b.entries) {
        const old = existing.find((x) => x.work_date === e.date && x.shift_slot === e.slot);
        if (old?.status === e.status) {
          await c.query('UPDATE availability_entries SET note = $4, submission_id = $5, updated_at = now() WHERE user_id = $1 AND work_date = $2 AND shift_slot = $3', [p.id, e.date, e.slot, e.note ?? null, sub.id]);
          continue;
        }
        changed++;
        await c.query(
          `INSERT INTO availability_entries (user_id, work_date, shift_slot, status, note, submission_id) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id, work_date, shift_slot) DO UPDATE SET status = $4, note = $5, submission_id = $6, updated_at = now()`,
          [p.id, e.date, e.slot, e.status, e.note ?? null, sub.id],
        );
        await c.query(
          'INSERT INTO availability_history (user_id, work_date, shift_slot, old_status, new_status, submission_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [p.id, e.date, e.slot, old?.status ?? null, e.status, sub.id],
        );
        if (old?.status === 'available' && e.status === 'unavailable') withdrawn.push({ date: e.date, slot: e.slot });
      }
      // Tell managers when availability is withdrawn for a week that already has a schedule.
      if (withdrawn.length) {
        const weeks = [...new Set(withdrawn.map((w) => weekStartOf(w.date)))];
        const affected = await many(
          c,
          `SELECT DISTINCT s.branch_id FROM schedules s WHERE s.week_start = ANY($1::date[]) AND s.branch_id = ANY($2::uuid[])`,
          [weeks, p.employeeBranchIds()],
        );
        for (const a of affected) {
          await notify(c, {
            recipients: await branchManagers(c, a.branch_id),
            branchId: a.branch_id,
            type: 'availability_withdrawn',
            title: `${p.user.firstName} ${p.user.lastName} withdrew availability`,
            body: `Now unavailable: ${withdrawn.map((w) => `${fmtDate(w.date)} shift ${w.slot}`).join(', ')}.`,
            entityType: 'user',
            entityId: p.id,
            link: `/manage/availability?employee=${p.id}`,
          });
        }
      }
      for (const br of p.employeeBranchIds()) await emit(c, { t: 'availability', b: br });
      await emit(c, { t: 'availability', u: [p.id] });
      await audit(c, { actorId: p.id, action: 'availability.submitted', entityType: 'availability_submission', entityId: sub.id, ip: req.ip, details: { periodType: b.periodType, startDate: b.startDate, entries: b.entries.length, changed } });
      return { ok: true, submissionId: sub.id, changed, saved: b.entries.length };
    });
  });

  // ---------------------------------------------------------- manager review
  app.get('/api/availability/overview', async (req) => {
    const q = z.object({ branchId: uuid, from: dateStr, to: dateStr }).parse(req.query);
    requireBranchManager(req, q.branchId);
    if (q.to < q.from || daysBetween(q.from, q.to) > 31) throw badRequest('Choose a range of at most a month.');
    const employees = await many(
      db(),
      `SELECT u.id, u.employee_number, u.first_name, u.last_name, u.status, p.home_branch_id, p.contract_weekly_minutes,
              (SELECT coalesce(json_agg(json_build_object('skillId', es.skill_id, 'name', sk.name, 'colorIndex', sk.color_index, 'isPrimary', es.is_primary) ORDER BY es.is_primary DESC, sk.name), '[]')
                 FROM employee_skills es JOIN skills sk ON sk.id = es.skill_id WHERE es.user_id = u.id AND es.revoked_at IS NULL) AS skills,
              (SELECT coalesce(json_agg(json_build_object('branchId', m.branch_id, 'branchName', b.name) ORDER BY b.name), '[]')
                 FROM branch_memberships m JOIN branches b ON b.id = m.branch_id WHERE m.user_id = u.id AND m.membership_role = 'employee' AND m.is_active) AS eligible,
              (SELECT coalesce(json_agg(json_build_object('branchId', pb.branch_id, 'rank', pb.rank) ORDER BY pb.rank), '[]')
                 FROM employee_preferred_branches pb WHERE pb.user_id = u.id) AS preferred_branches,
              (SELECT coalesce(json_agg(json_build_object('slot', sp.shift_slot, 'preference', sp.preference)), '[]')
                 FROM employee_shift_preferences sp WHERE sp.user_id = u.id) AS shift_prefs,
              (SELECT max(submitted_at) FROM availability_submissions s WHERE s.user_id = u.id AND s.end_date >= $2 AND s.start_date <= $3) AS last_submitted
         FROM users u
         JOIN branch_memberships m ON m.user_id = u.id AND m.branch_id = $1 AND m.membership_role = 'employee' AND m.is_active
         LEFT JOIN employee_profiles p ON p.user_id = u.id
        WHERE u.status = 'active'
        ORDER BY u.last_name, u.first_name`,
      [q.branchId, q.from, q.to],
    );
    const ids = employees.map((e) => e.id);
    const entries = await many(
      db(),
      'SELECT user_id, work_date, shift_slot, status, note FROM availability_entries WHERE user_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3',
      [ids, q.from, q.to],
    );
    const assigned = await many(
      db(),
      `SELECT user_id, work_date, shift_slot, branch_id FROM shift_assignments WHERE user_id = ANY($1::uuid[]) AND status = 'active' AND work_date BETWEEN $2 AND $3`,
      [ids, q.from, q.to],
    );
    return {
      from: q.from,
      to: q.to,
      employees: employees.map((e) => ({
        id: e.id,
        employeeNumber: e.employee_number,
        name: `${e.first_name} ${e.last_name}`,
        firstName: e.first_name,
        lastName: e.last_name,
        homeBranchId: e.home_branch_id,
        contractWeeklyMinutes: e.contract_weekly_minutes,
        skills: e.skills,
        eligibleBranches: e.eligible,
        preferredBranches: e.preferred_branches,
        shiftPreferences: e.shift_prefs,
        lastSubmitted: e.last_submitted,
        entries: entries.filter((x) => x.user_id === e.id).map((x) => ({ date: x.work_date, slot: x.shift_slot, status: x.status, note: x.note })),
        assigned: assigned.filter((x) => x.user_id === e.id).map((x) => ({ date: x.work_date, slot: x.shift_slot, branchId: x.branch_id })),
      })),
    };
  });

  app.get('/api/availability/employee/:id/history', async (req) => {
    const p = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await assertCanManageEmployee(db(), p, id);
    const rows = await many(
      db(),
      `SELECT work_date, shift_slot, old_status, new_status, changed_at FROM availability_history WHERE user_id = $1 ORDER BY changed_at DESC LIMIT 100`,
      [id],
    );
    return rows.map((r) => ({ date: r.work_date, slot: r.shift_slot, from: r.old_status, to: r.new_status, changedAt: r.changed_at }));
  });
}
