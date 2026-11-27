/**
 * Schedule service: bridges the database and the pure scheduling engine.
 *
 * Concurrency model
 * - Every change to a schedule's working copy locks the schedule row (FOR UPDATE), so edits to
 *   one schedule are serialised and each bumps `revision`.
 * - Changes that add work for an employee also take a per-employee advisory lock, so two
 *   managers in different branches cannot both pass the daily-limit check for the same person.
 * - The exclusion constraint on shift_assignments is the final guard against overlaps.
 * - Publishing requires the revision the manager validated; otherwise it is refused.
 */
import type { Principal } from '../auth/principal.js';
import type { Db, Tx } from '../db/pool.js';
import { advisoryLock, many, one } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors.js';
import { branchManagers, emit, notify } from '../lib/events.js';
import { addDays, eachDate, isoWeekday, isWeekend, localTimeOf, localToUtcMs, weekStartOf } from '../lib/time.js';
import { placeBreaksForDay } from '../scheduling/breaks.js';
import { generateSchedule } from '../scheduling/generate.js';
import { AssignmentIndex, checkCandidate, dayPlan, fmtDate } from '../scheduling/rules.js';
import type {
  Assignment,
  AvailabilityStatus,
  CellRequirement,
  EmployeeInfo,
  EngineContext,
  Issue,
  PlacedBreak,
  ShiftTemplate,
} from '../scheduling/types.js';
import { validateSchedule } from '../scheduling/validate.js';
import { policyRow, toEnginePolicy } from './policy.js';

export async function loadTemplates(client: Db): Promise<ShiftTemplate[]> {
  const rows = await many(client, 'SELECT slot, start_time, end_time FROM shift_templates ORDER BY slot');
  return rows.map((r) => ({ slot: r.slot, start: r.start_time, end: r.end_time }));
}

export function slotTimesFn(templates: ShiftTemplate[]) {
  const cache = new Map<string, { startMs: number; endMs: number }>();
  return (date: string, slot: number) => {
    const k = `${date}:${slot}`;
    let v = cache.get(k);
    if (!v) {
      const t = templates.find((x) => x.slot === slot);
      if (!t) throw new Error(`Unknown shift slot ${slot}`);
      v = { startMs: localToUtcMs(date, t.start), endMs: localToUtcMs(date, t.end) };
      cache.set(k, v);
    }
    return v;
  };
}

export interface LoadOptions {
  scheduleId?: string | null;
  /** Restrict employee-specific data to these users (faster single-assignment checks). */
  userIds?: string[];
  policyVersionId?: number;
}

/** Builds the engine input for one branch and ISO week from the database. */
export async function loadContext(client: Db, branchId: string, weekStart: string, opts: LoadOptions = {}): Promise<EngineContext> {
  const templates = await loadTemplates(client);
  const policy = toEnginePolicy(await policyRow(client, opts.policyVersionId));
  const dates = eachDate(weekStart, addDays(weekStart, 6));
  const from = addDays(weekStart, -14);
  const to = addDays(weekStart, 20);

  const assignmentRows = opts.scheduleId
    ? await many(
        client,
        `SELECT id, user_id, branch_id, work_date, shift_slot, role_skill_id, source FROM shift_assignments
          WHERE schedule_id = $1 AND status = 'active'`,
        [opts.scheduleId],
      )
    : [];
  const assignments: Assignment[] = assignmentRows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    branchId: r.branch_id,
    date: r.work_date,
    slot: r.shift_slot,
    roleSkillId: r.role_skill_id,
    source: r.source,
  }));

  let userIds = opts.userIds;
  if (!userIds) {
    const members = await many(
      client,
      `SELECT user_id FROM branch_memberships WHERE branch_id = $1 AND membership_role = 'employee' AND is_active`,
      [branchId],
    );
    userIds = [...new Set([...members.map((m) => m.user_id), ...assignments.map((a) => a.userId)])];
  }

  const users = await many(
    client,
    `SELECT u.id, u.first_name, u.last_name, u.status, p.contract_weekly_minutes,
            w.max_daily_work_minutes, w.max_weekly_work_minutes, w.min_daily_rest_minutes, w.max_consecutive_work_days, w.latest_end_time
       FROM users u
       LEFT JOIN employee_profiles p ON p.user_id = u.id
       LEFT JOIN working_time_profiles w ON w.id = p.working_time_profile_id
      WHERE u.id = ANY($1::uuid[])`,
    [userIds],
  );
  const memberships = await many(
    client,
    `SELECT user_id, branch_id FROM branch_memberships WHERE user_id = ANY($1::uuid[]) AND membership_role = 'employee' AND is_active`,
    [userIds],
  );
  const skills = await many(
    client,
    `SELECT user_id, skill_id, valid_until FROM employee_skills es JOIN skills s ON s.id = es.skill_id
      WHERE es.user_id = ANY($1::uuid[]) AND es.revoked_at IS NULL AND s.is_active`,
    [userIds],
  );
  const prefBranches = await many(client, 'SELECT user_id, branch_id, rank FROM employee_preferred_branches WHERE user_id = ANY($1::uuid[])', [userIds]);
  const prefShifts = await many(client, 'SELECT user_id, shift_slot, preference FROM employee_shift_preferences WHERE user_id = ANY($1::uuid[])', [userIds]);
  const avRows = await many(
    client,
    `SELECT user_id, work_date, shift_slot, status FROM availability_entries
      WHERE user_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3`,
    [userIds, dates[0], dates[6]],
  );
  const external = await many(
    client,
    `SELECT a.id, a.user_id, a.branch_id, a.work_date, a.shift_slot, a.role_skill_id FROM shift_assignments a
      WHERE a.user_id = ANY($1::uuid[]) AND a.status = 'active' AND a.work_date BETWEEN $2 AND $3
        AND ($4::uuid IS NULL OR a.schedule_id <> $4)`,
    [userIds, from, to, opts.scheduleId ?? null],
  );
  const sick = await many(client, 'SELECT user_id, work_date FROM sickness_reports WHERE user_id = ANY($1::uuid[]) AND work_date BETWEEN $2 AND $3', [userIds, from, to]);

  // Fairness history: worked (published, active) assignments in the lookback window.
  const lookFrom = addDays(weekStart, -7 * policy.fairnessLookbackWeeks);
  const hist = policy.fairnessLookbackWeeks
    ? await many(
        client,
        `SELECT a.user_id, a.branch_id, a.work_date, a.shift_slot FROM shift_assignments a JOIN schedules s ON s.id = a.schedule_id
          WHERE a.user_id = ANY($1::uuid[]) AND a.status = 'active' AND s.status = 'published' AND a.work_date >= $2 AND a.work_date < $3`,
        [userIds, lookFrom, weekStart],
      )
    : [];

  const skillRows = await many(client, 'SELECT id, name FROM skills');
  const reqRows = await many(client, 'SELECT weekday, shift_slot, min_staff FROM staffing_requirements WHERE branch_id = $1', [branchId]);
  const skillReqRows = await many(client, 'SELECT weekday, shift_slot, skill_id, min_count FROM skill_requirements WHERE branch_id = $1', [branchId]);

  const slotTimes = slotTimesFn(templates);
  const ctx: EngineContext = {
    branchId,
    dates,
    templates,
    policy,
    employees: new Map(),
    availability: new Map(),
    requirements: [],
    assignments,
    externalAssignments: external.map((r) => ({ id: r.id, userId: r.user_id, branchId: r.branch_id, date: r.work_date, slot: r.shift_slot, roleSkillId: r.role_skill_id })),
    sickDays: new Set(sick.map((r) => `${r.user_id}:${r.work_date}`)),
    skillNames: new Map(skillRows.map((r) => [r.id, r.name])),
    slotTimes,
  };

  for (const d of dates) {
    const wd = isoWeekday(d);
    for (const t of templates) {
      const req = reqRows.find((r) => r.weekday === wd && r.shift_slot === t.slot);
      ctx.requirements.push({
        date: d,
        slot: t.slot,
        minStaff: req?.min_staff ?? 0,
        skills: skillReqRows.filter((r) => r.weekday === wd && r.shift_slot === t.slot).map((r) => ({ skillId: r.skill_id, minCount: r.min_count })),
      });
    }
  }

  for (const r of avRows) {
    let m = ctx.availability.get(r.user_id);
    if (!m) ctx.availability.set(r.user_id, (m = new Map()));
    m.set(`${r.work_date}:${r.shift_slot}`, r.status as AvailabilityStatus);
  }

  const histByUser = new Map<string, Assignment[]>();
  for (const r of hist) {
    const arr = histByUser.get(r.user_id) ?? [];
    arr.push({ userId: r.user_id, branchId: r.branch_id, date: r.work_date, slot: r.shift_slot, roleSkillId: null });
    histByUser.set(r.user_id, arr);
  }
  const prevWeek = addDays(weekStart, -7);
  const lastSlot = Math.max(...templates.map((t) => t.slot));

  for (const u of users) {
    const lim = {
      maxDailyWorkMinutes: Math.min(policy.maxDailyWorkMinutes, u.max_daily_work_minutes ?? Infinity),
      maxWeeklyWorkMinutes: Math.min(policy.maxWeeklyWorkMinutes, u.max_weekly_work_minutes ?? Infinity),
      minDailyRestMinutes: Math.max(policy.minDailyRestMinutes, u.min_daily_rest_minutes ?? 0),
      maxConsecutiveWorkDays: Math.min(policy.maxConsecutiveWorkDays, u.max_consecutive_work_days ?? Infinity),
      latestEndTime: u.latest_end_time ?? null,
    };
    const h = histByUser.get(u.id) ?? [];
    const byDate = new Map<string, Assignment[]>();
    for (const a of h) byDate.set(a.date, [...(byDate.get(a.date) ?? []), a]);
    let minutes = 0;
    for (const items of byDate.values()) minutes += dayPlan(ctx, items).workMinutes;
    const emp: EmployeeInfo = {
      id: u.id,
      name: `${u.first_name} ${u.last_name}`,
      active: u.status === 'active',
      branchIds: memberships.filter((m) => m.user_id === u.id).map((m) => m.branch_id),
      skills: skills.filter((s) => s.user_id === u.id).map((s) => ({ skillId: s.skill_id, validUntil: s.valid_until })),
      preferredBranches: prefBranches.filter((p) => p.user_id === u.id).map((p) => ({ branchId: p.branch_id, rank: p.rank })),
      shiftPreferences: Object.fromEntries(prefShifts.filter((p) => p.user_id === u.id).map((p) => [p.shift_slot, p.preference])),
      contractWeeklyMinutes: u.contract_weekly_minutes,
      limits: lim,
      history: {
        weeks: policy.fairnessLookbackWeeks,
        workMinutes: minutes,
        weekendShifts: h.filter((a) => isWeekend(a.date)).length,
        lateShifts: h.filter((a) => a.slot === lastSlot).length,
      },
      previousWeekPattern: new Set(h.filter((a) => weekStartOf(a.date) === prevWeek).map((a) => `${isoWeekday(a.date)}:${a.slot}`)),
    };
    ctx.employees.set(u.id, emp);
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Schedule rows
// ---------------------------------------------------------------------------

export async function getOrCreateSchedule(client: Tx, branchId: string, weekStart: string, actorId: string): Promise<any> {
  if (weekStartOf(weekStart) !== weekStart) throw unprocessable('A schedule week must start on a Monday.', 'BAD_WEEK');
  const existing = await one(client, 'SELECT * FROM schedules WHERE branch_id = $1 AND week_start = $2 FOR UPDATE', [branchId, weekStart]);
  if (existing) return existing;
  const created = await one(
    client,
    `INSERT INTO schedules (branch_id, week_start, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (branch_id, week_start) DO NOTHING RETURNING *`,
    [branchId, weekStart, actorId],
  );
  if (!created) return one(client, 'SELECT * FROM schedules WHERE branch_id = $1 AND week_start = $2 FOR UPDATE', [branchId, weekStart]);
  const templates = await loadTemplates(client);
  const times = slotTimesFn(templates);
  for (const d of eachDate(weekStart, addDays(weekStart, 6))) {
    for (const t of templates) {
      const { startMs, endMs } = times(d, t.slot);
      await client.query(
        `INSERT INTO shifts (schedule_id, branch_id, work_date, shift_slot, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [created.id, branchId, d, t.slot, new Date(startMs), new Date(endMs)],
      );
    }
  }
  await audit(client, { actorId, action: 'schedule.created', entityType: 'schedule', entityId: created.id, branchId, details: { weekStart } });
  return one(client, 'SELECT * FROM schedules WHERE id = $1 FOR UPDATE', [created.id]);
}

export async function lockSchedule(client: Tx, scheduleId: string): Promise<any> {
  const s = await one(client, 'SELECT * FROM schedules WHERE id = $1 FOR UPDATE', [scheduleId]);
  if (!s) throw notFound('Schedule');
  return s;
}

async function bumpRevision(client: Tx, scheduleId: string): Promise<number> {
  const r = await one(client, 'UPDATE schedules SET revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING revision', [scheduleId]);
  return r.revision;
}

/** Recomputes the stored breaks for one branch-day from the current working copy. */
export async function recomputeBreaks(client: Tx, ctx: EngineContext, scheduleId: string, dates: string[]): Promise<void> {
  const day = await many(
    client,
    `SELECT user_id, branch_id, work_date, shift_slot, role_skill_id FROM shift_assignments
      WHERE schedule_id = $1 AND status = 'active' AND work_date = ANY($2::date[])`,
    [scheduleId, dates],
  );
  await client.query('DELETE FROM break_assignments WHERE schedule_id = $1 AND work_date = ANY($2::date[])', [scheduleId, dates]);
  for (const date of dates) {
    const items: Assignment[] = day
      .filter((r) => r.work_date === date)
      .map((r) => ({ userId: r.user_id, branchId: r.branch_id, date, slot: r.shift_slot, roleSkillId: r.role_skill_id }));
    const reqBySlot = new Map(ctx.requirements.filter((r) => r.date === date).map((r) => [r.slot, r] as [number, CellRequirement]));
    const { breaks } = placeBreaksForDay(ctx, date, items, reqBySlot);
    await insertBreaks(client, scheduleId, breaks);
  }
}

async function insertBreaks(client: Tx, scheduleId: string, breaks: PlacedBreak[]) {
  for (const b of breaks) {
    await client.query(
      `INSERT INTO break_assignments (schedule_id, branch_id, user_id, work_date, starts_at, ends_at, minutes, block_start_slot, block_end_slot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [scheduleId, b.branchId, b.userId, b.date, new Date(b.startMs), new Date(b.endMs), b.minutes, b.blockStartSlot, b.blockEndSlot],
    );
  }
}

async function insertAssignment(client: Tx, scheduleId: string, a: Assignment, actorId: string, replaces?: string | null): Promise<string> {
  const shift = await one(client, 'SELECT id, starts_at, ends_at FROM shifts WHERE schedule_id = $1 AND work_date = $2 AND shift_slot = $3', [scheduleId, a.date, a.slot]);
  if (!shift) throw unprocessable('That shift is not part of this schedule week.', 'BAD_SHIFT');
  const row = await one(
    client,
    `INSERT INTO shift_assignments (shift_id, schedule_id, branch_id, user_id, work_date, shift_slot, starts_at, ends_at,
                                    role_skill_id, source, replaces_assignment_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [shift.id, scheduleId, a.branchId, a.userId, a.date, a.slot, shift.starts_at, shift.ends_at, a.roleSkillId, a.source ?? 'manual', replaces ?? null, actorId],
  );
  return row.id;
}

function violationError(violations: { code: string; message: string }[], name?: string) {
  return unprocessable(
    `${name ? `${name} cannot be assigned: ` : 'This assignment breaks a scheduling rule: '}${violations.map((v) => v.message).join(' ')}`,
    'RULE_VIOLATION',
    { violations },
  );
}

/** Locks employees in a stable order so concurrent multi-employee transactions cannot deadlock. */
export async function lockEmployees(client: Tx, userIds: string[]) {
  for (const id of [...new Set(userIds)].sort()) await advisoryLock(client, 'employee', id);
}

// ---------------------------------------------------------------------------
// Working-copy mutations
// ---------------------------------------------------------------------------

export interface AssignInput {
  userId: string;
  date: string;
  slot: number;
  roleSkillId: string | null;
}

export async function addAssignment(client: Tx, p: Principal, branchId: string, weekStart: string, input: AssignInput, ip?: string) {
  const schedule = await getOrCreateSchedule(client, branchId, weekStart, p.id);
  if (input.date < weekStart || input.date > addDays(weekStart, 6)) throw unprocessable('The date is outside this schedule week.', 'BAD_SHIFT');
  await lockEmployees(client, [input.userId]);
  const ctx = await loadContext(client, branchId, weekStart, { scheduleId: schedule.id, userIds: [input.userId] });
  const cand: Assignment = { ...input, branchId, source: 'manual' };
  const v = checkCandidate(ctx, new AssignmentIndex([ctx.assignments, ctx.externalAssignments]), cand);
  if (v.length) throw violationError(v, ctx.employees.get(input.userId)?.name);
  const id = await insertAssignment(client, schedule.id, cand, p.id);
  const revision = await bumpRevision(client, schedule.id);
  await recomputeBreaks(client, await loadContext(client, branchId, weekStart, { scheduleId: schedule.id, userIds: [] }), schedule.id, [input.date]);
  await audit(client, { actorId: p.id, action: 'assignment.added', entityType: 'shift_assignment', entityId: id, branchId, ip, details: { ...input } });
  await emit(client, { t: 'schedule', b: branchId });
  return { id, scheduleId: schedule.id, revision };
}

export async function getAssignmentForUpdate(client: Tx, assignmentId: string) {
  const a = await one(
    client,
    `SELECT a.*, s.week_start FROM shift_assignments a JOIN schedules s ON s.id = a.schedule_id WHERE a.id = $1 FOR UPDATE OF a`,
    [assignmentId],
  );
  if (!a) throw notFound('Assignment');
  return a;
}

async function cancelOpenCoverFor(client: Tx, assignmentIds: string[], actorId: string, note: string) {
  if (!assignmentIds.length) return;
  const rows = await many(
    client,
    `UPDATE cover_requests SET status = 'cancelled', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now(),
            claimed_by = NULL
      WHERE assignment_id = ANY($1::uuid[]) AND status IN ('open', 'pending') RETURNING id, requester_id, branch_id`,
    [assignmentIds, actorId, note],
  );
  for (const r of rows) {
    await client.query(`UPDATE cover_claims SET status = 'superseded', updated_at = now() WHERE cover_request_id = $1 AND status IN ('interested', 'claimed')`, [r.id]);
    await emit(client, { t: 'cover', b: r.branch_id, all: true });
  }
}

export async function removeAssignment(client: Tx, p: Principal, assignmentId: string, ip?: string) {
  const a = await getAssignmentForUpdate(client, assignmentId);
  if (!p.canManageBranch(a.branch_id)) throw notFound('Assignment');
  await lockSchedule(client, a.schedule_id);
  if (a.status !== 'active') throw conflict('Only active assignments can be removed.');
  await client.query(`UPDATE shift_assignments SET status = 'removed', status_changed_by = $2, updated_at = now() WHERE id = $1`, [a.id, p.id]);
  await cancelOpenCoverFor(client, [a.id], p.id, 'The assignment was removed from the schedule.');
  const revision = await bumpRevision(client, a.schedule_id);
  await recomputeBreaks(client, await loadContext(client, a.branch_id, a.week_start, { scheduleId: a.schedule_id, userIds: [] }), a.schedule_id, [a.work_date]);
  await audit(client, { actorId: p.id, action: 'assignment.removed', entityType: 'shift_assignment', entityId: a.id, branchId: a.branch_id, ip, details: { userId: a.user_id, date: a.work_date, slot: a.shift_slot } });
  await emit(client, { t: 'schedule', b: a.branch_id });
  return { revision };
}

/** Move to another shift, reassign to another employee and/or change role. Old row is kept as 'removed'. */
export async function updateAssignment(
  client: Tx,
  p: Principal,
  assignmentId: string,
  change: { userId?: string; date?: string; slot?: number; roleSkillId?: string | null },
  ip?: string,
) {
  const a = await getAssignmentForUpdate(client, assignmentId);
  if (!p.canManageBranch(a.branch_id)) throw notFound('Assignment');
  await lockSchedule(client, a.schedule_id);
  if (a.status !== 'active') throw conflict('Only active assignments can be changed.');
  const next: Assignment = {
    userId: change.userId ?? a.user_id,
    branchId: a.branch_id,
    date: change.date ?? a.work_date,
    slot: change.slot ?? a.shift_slot,
    roleSkillId: change.roleSkillId === undefined ? a.role_skill_id : change.roleSkillId,
    source: 'manual',
  };
  if (next.date < a.week_start || next.date > addDays(a.week_start, 6)) throw unprocessable('Moves must stay within the same week.', 'BAD_SHIFT');
  await lockEmployees(client, [a.user_id, next.userId]);
  const ctx = await loadContext(client, a.branch_id, a.week_start, { scheduleId: a.schedule_id, userIds: [next.userId] });
  const index = new AssignmentIndex([ctx.assignments.filter((x) => x.id !== a.id), ctx.externalAssignments]);
  const v = checkCandidate(ctx, index, next);
  if (v.length) throw violationError(v, ctx.employees.get(next.userId)?.name);
  await client.query(`UPDATE shift_assignments SET status = 'removed', status_changed_by = $2, updated_at = now() WHERE id = $1`, [a.id, p.id]);
  const id = await insertAssignment(client, a.schedule_id, next, p.id);
  // A pending cover request follows the shift only if the same person still works it.
  if (next.userId === a.user_id && next.date === a.work_date && next.slot === a.shift_slot) {
    await client.query(`UPDATE cover_requests SET assignment_id = $2, role_skill_id = $3, updated_at = now() WHERE assignment_id = $1 AND status IN ('open', 'pending')`, [a.id, id, next.roleSkillId]);
  } else {
    await cancelOpenCoverFor(client, [a.id], p.id, 'The shift was changed by a manager.');
  }
  const revision = await bumpRevision(client, a.schedule_id);
  const fresh = await loadContext(client, a.branch_id, a.week_start, { scheduleId: a.schedule_id, userIds: [] });
  await recomputeBreaks(client, fresh, a.schedule_id, [...new Set([a.work_date, next.date])]);
  await audit(client, {
    actorId: p.id,
    action: 'assignment.changed',
    entityType: 'shift_assignment',
    entityId: id,
    branchId: a.branch_id,
    ip,
    details: { from: { userId: a.user_id, date: a.work_date, slot: a.shift_slot, role: a.role_skill_id }, to: next },
  });
  await emit(client, { t: 'schedule', b: a.branch_id });
  return { id, revision };
}

async function recordRun(client: Tx, scheduleId: string, kind: 'generate' | 'validate' | 'publish', policyVersionId: number, revision: number, actorId: string, issues: Issue[], added = 0, mode?: string) {
  const run = await one(
    client,
    `INSERT INTO scheduling_runs (schedule_id, kind, mode, policy_version_id, schedule_revision, assignments_added, error_count, warning_count, started_by, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()) RETURNING id`,
    [scheduleId, kind, mode ?? null, policyVersionId, revision, added, issues.filter((i) => i.severity === 'error').length, issues.filter((i) => i.severity === 'warning').length, actorId],
  );
  for (const i of issues) {
    await client.query(
      `INSERT INTO scheduling_run_issues (run_id, severity, code, work_date, shift_slot, user_id, skill_id, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [run.id, i.severity, i.code, i.date ?? null, i.slot ?? null, i.userId ?? null, i.skillId ?? null, i.message],
    );
  }
  return run.id as string;
}

export async function generate(client: Tx, p: Principal, branchId: string, weekStart: string, mode: 'fill' | 'replace', ip?: string) {
  const schedule = await getOrCreateSchedule(client, branchId, weekStart, p.id);
  const members = await many(client, `SELECT user_id FROM branch_memberships WHERE branch_id = $1 AND membership_role = 'employee' AND is_active`, [branchId]);
  await lockEmployees(client, members.map((m) => m.user_id));
  const ctx = await loadContext(client, branchId, weekStart, { scheduleId: schedule.id });
  const started = Date.now();
  const result = generateSchedule(ctx, mode);
  const durationMs = Date.now() - started;
  for (const r of result.removed) {
    await client.query(`UPDATE shift_assignments SET status = 'removed', status_changed_by = $2, updated_at = now() WHERE id = $1`, [r.id, p.id]);
  }
  if (result.removed.length) await cancelOpenCoverFor(client, result.removed.map((r) => r.id!), p.id, 'The schedule was regenerated.');
  for (const a of result.added) await insertAssignment(client, schedule.id, a, p.id);
  const revision = await bumpRevision(client, schedule.id);
  await client.query('DELETE FROM break_assignments WHERE schedule_id = $1', [schedule.id]);
  await insertBreaks(client, schedule.id, result.breaks);
  const runId = await recordRun(client, schedule.id, 'generate', ctx.policy.versionId, revision, p.id, result.issues, result.added.length, mode);
  await audit(client, { actorId: p.id, action: 'schedule.generated', entityType: 'schedule', entityId: schedule.id, branchId, ip, details: { mode, added: result.added.length, removed: result.removed.length, durationMs } });
  await emit(client, { t: 'schedule', b: branchId });
  return { scheduleId: schedule.id, runId, revision, added: result.added.length, removed: result.removed.length, issues: result.issues, durationMs };
}

// ---------------------------------------------------------------------------
// Publication and versions
// ---------------------------------------------------------------------------

interface VersionRow {
  assignment_id: string;
  user_id: string;
  work_date: string;
  shift_slot: number;
  starts_at: Date;
  ends_at: Date;
  role_skill_id: string | null;
  status: 'active' | 'sick' | 'replaced';
}

async function versionRows(client: Db, versionId: string | null): Promise<VersionRow[]> {
  if (!versionId) return [];
  return many(client, 'SELECT * FROM schedule_version_assignments WHERE version_id = $1', [versionId]);
}

async function writeVersion(
  client: Tx,
  scheduleId: string,
  reason: 'publish' | 'cover' | 'sickness',
  policyVersionId: number,
  rows: VersionRow[],
  breaks: PlacedBreak[] | { user_id: string; work_date: string; starts_at: Date; ends_at: Date; minutes: number }[],
  actorId: string,
  summary: string,
): Promise<{ id: string; versionNo: number }> {
  const next = await one(client, 'SELECT coalesce(max(version_no), 0) + 1 AS n FROM schedule_versions WHERE schedule_id = $1', [scheduleId]);
  const v = await one(
    client,
    `INSERT INTO schedule_versions (schedule_id, version_no, reason, policy_version_id, change_summary, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [scheduleId, next.n, reason, policyVersionId, summary, actorId],
  );
  for (const r of rows) {
    await client.query(
      `INSERT INTO schedule_version_assignments (version_id, assignment_id, user_id, work_date, shift_slot, starts_at, ends_at, role_skill_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [v.id, r.assignment_id, r.user_id, r.work_date, r.shift_slot, r.starts_at, r.ends_at, r.role_skill_id, r.status],
    );
  }
  for (const b of breaks as any[]) {
    const userId = b.userId ?? b.user_id;
    const date = b.date ?? b.work_date;
    const start = b.startMs !== undefined ? new Date(b.startMs) : b.starts_at;
    const end = b.endMs !== undefined ? new Date(b.endMs) : b.ends_at;
    await client.query(
      `INSERT INTO schedule_version_breaks (version_id, user_id, work_date, starts_at, ends_at, minutes) VALUES ($1,$2,$3,$4,$5,$6)`,
      [v.id, userId, date, start, end, b.minutes],
    );
  }
  return { id: v.id, versionNo: next.n };
}

function diffVersions(prev: VersionRow[], next: VersionRow[]) {
  const key = (r: VersionRow) => `${r.user_id}|${r.work_date}|${r.shift_slot}`;
  const activePrev = new Map(prev.filter((r) => r.status === 'active').map((r) => [key(r), r]));
  const activeNext = new Map(next.filter((r) => r.status === 'active').map((r) => [key(r), r]));
  const added = [...activeNext.entries()].filter(([k]) => !activePrev.has(k)).map(([, r]) => r);
  const removed = [...activePrev.entries()].filter(([k]) => !activeNext.has(k)).map(([, r]) => r);
  const roleChanged = [...activeNext.entries()].filter(([k, r]) => activePrev.has(k) && activePrev.get(k)!.role_skill_id !== r.role_skill_id).map(([, r]) => r);
  const affected = new Set([...added, ...removed, ...roleChanged].map((r) => r.user_id));
  return { added, removed, roleChanged, affected };
}

export async function publish(client: Tx, p: Principal, scheduleId: string, expectedRevision: number, ip?: string) {
  const s = await lockSchedule(client, scheduleId);
  if (!p.canManageBranch(s.branch_id)) throw notFound('Schedule');
  if (s.revision !== expectedRevision) {
    throw conflict('The schedule changed since you last reviewed it. Review the latest version and publish again.', 'STALE_REVISION', { revision: s.revision });
  }
  if (s.status === 'published' && s.published_revision === s.revision) throw conflict('There are no unpublished changes.', 'NOTHING_TO_PUBLISH');
  const ctx = await loadContext(client, s.branch_id, s.week_start, { scheduleId });
  const result = validateSchedule(ctx);
  const errors = result.issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    await recordRun(client, scheduleId, 'publish', ctx.policy.versionId, s.revision, p.id, result.issues);
    throw unprocessable(`The schedule has ${errors.length} problem${errors.length === 1 ? '' : 's'} that must be fixed before publishing.`, 'VALIDATION_FAILED', { issues: result.issues });
  }
  const rows: VersionRow[] = await many(
    client,
    `SELECT id AS assignment_id, user_id, work_date, shift_slot, starts_at, ends_at, role_skill_id, status
       FROM shift_assignments WHERE schedule_id = $1 AND status IN ('active', 'sick', 'replaced')`,
    [scheduleId],
  );
  const prev = await versionRows(client, s.published_version_id);
  const diff = diffVersions(prev, rows);
  const first = !s.published_version_id;
  const summary = first ? `Published with ${rows.filter((r) => r.status === 'active').length} shifts` : `${diff.added.length} added, ${diff.removed.length} removed, ${diff.roleChanged.length} role changes`;
  const version = await writeVersion(client, scheduleId, 'publish', ctx.policy.versionId, rows, result.breaks, p.id, summary);
  await client.query(
    `UPDATE schedules SET status = 'published', published_version_id = $2, published_revision = revision, updated_at = now() WHERE id = $1`,
    [scheduleId, version.id],
  );
  await recordRun(client, scheduleId, 'publish', ctx.policy.versionId, s.revision, p.id, result.issues);

  const branch = await one(client, 'SELECT name FROM branches WHERE id = $1', [s.branch_id]);
  const weekLabel = `week of ${fmtDate(s.week_start)}`;
  const link = `/my/schedule?week=${s.week_start}`;
  if (first) {
    const everyone = [...new Set(rows.filter((r) => r.status === 'active').map((r) => r.user_id))];
    await notify(client, { recipients: everyone, branchId: s.branch_id, type: 'schedule_published', title: `Your ${branch.name} schedule for the ${weekLabel} is published`, entityType: 'schedule', entityId: scheduleId, link });
  } else {
    for (const userId of diff.affected) {
      const lines = [
        ...diff.added.filter((r) => r.user_id === userId).map((r) => `Added: ${shiftText(ctx, r.work_date, r.shift_slot)}`),
        ...diff.removed.filter((r) => r.user_id === userId).map((r) => `Removed: ${shiftText(ctx, r.work_date, r.shift_slot)}`),
        ...diff.roleChanged.filter((r) => r.user_id === userId).map((r) => `Role changed: ${shiftText(ctx, r.work_date, r.shift_slot)}`),
      ];
      await notify(client, { recipients: [userId], branchId: s.branch_id, type: 'schedule_changed', title: `Your ${branch.name} schedule for the ${weekLabel} changed`, body: lines.join('\n'), entityType: 'schedule', entityId: scheduleId, link });
    }
  }
  await audit(client, { actorId: p.id, action: 'schedule.published', entityType: 'schedule', entityId: scheduleId, branchId: s.branch_id, ip, details: { versionNo: version.versionNo, affected: diff.affected.size } });
  await emit(client, { t: 'schedule', b: s.branch_id, all: true });
  return { versionId: version.id, versionNo: version.versionNo, affected: diff.affected.size, warnings: result.issues.filter((i) => i.severity !== 'error') };
}

export function shiftText(ctx: { templates: ShiftTemplate[] }, date: string, slot: number) {
  const t = ctx.templates.find((x) => x.slot === slot);
  return `${fmtDate(date)} ${t?.start}–${t?.end}`;
}

/**
 * Applies an operational change (sickness, approved cover) to the *published* schedule
 * immediately, by deriving a new version from the current published one. Unpublished edits in
 * the working copy are not leaked into it.
 */
export async function deriveVersion(
  client: Tx,
  scheduleId: string,
  reason: 'cover' | 'sickness',
  actorId: string,
  mutate: (rows: VersionRow[]) => VersionRow[],
  summary: string,
  affectedDate: string,
): Promise<void> {
  const s = await lockSchedule(client, scheduleId);
  if (!s.published_version_id) return;
  const prev = await versionRows(client, s.published_version_id);
  const next = mutate(prev.map((r) => ({ ...r })));
  const prevVersion = await one(client, 'SELECT policy_version_id FROM schedule_versions WHERE id = $1', [s.published_version_id]);
  const ctx = await loadContext(client, s.branch_id, s.week_start, { userIds: [] });
  const prevBreaks = await many(client, 'SELECT user_id, work_date, starts_at, ends_at, minutes FROM schedule_version_breaks WHERE version_id = $1 AND work_date <> $2', [s.published_version_id, affectedDate]);
  const dayItems: Assignment[] = next
    .filter((r) => r.work_date === affectedDate && r.status === 'active')
    .map((r) => ({ userId: r.user_id, branchId: s.branch_id, date: r.work_date, slot: r.shift_slot, roleSkillId: r.role_skill_id }));
  const reqBySlot = new Map(ctx.requirements.filter((r) => r.date === affectedDate).map((r) => [r.slot, r] as [number, CellRequirement]));
  const dayBreaks = placeBreaksForDay(ctx, affectedDate, dayItems, reqBySlot).breaks;
  const version = await writeVersion(client, scheduleId, reason, prevVersion.policy_version_id, next, [...prevBreaks, ...dayBreaks] as any, actorId, summary);
  await client.query(
    `UPDATE schedules SET published_version_id = $2,
            published_revision = CASE WHEN published_revision = revision THEN revision + 1 ELSE published_revision END,
            revision = revision + 1, updated_at = now()
      WHERE id = $1`,
    [scheduleId, version.id],
  );
  await recomputeBreaks(client, ctx, scheduleId, [affectedDate]);
}

export type { VersionRow };

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export async function weekView(client: Db, branchId: string, weekStart: string) {
  const schedule = await one(
    client,
    `SELECT s.*, v.version_no AS published_version_no, v.created_at AS published_at
       FROM schedules s LEFT JOIN schedule_versions v ON v.id = s.published_version_id
      WHERE s.branch_id = $1 AND s.week_start = $2`,
    [branchId, weekStart],
  );
  const ctx = await loadContext(client, branchId, weekStart, { scheduleId: schedule?.id ?? null });
  const validation = validateSchedule(ctx);
  const rows = schedule
    ? await many(
        client,
        `SELECT a.id, a.user_id, a.work_date, a.shift_slot, a.role_skill_id, a.status, a.source, u.first_name, u.last_name, u.employee_number,
                (SELECT sk.name FROM employee_skills es JOIN skills sk ON sk.id = es.skill_id
                  WHERE es.user_id = a.user_id AND es.revoked_at IS NULL ORDER BY es.is_primary DESC, sk.name LIMIT 1) AS primary_skill,
                cr.id AS cover_id, cr.status AS cover_status, cr.kind AS cover_kind
           FROM shift_assignments a
           JOIN users u ON u.id = a.user_id
           LEFT JOIN cover_requests cr ON cr.assignment_id = a.id AND cr.status IN ('open', 'pending')
          WHERE a.schedule_id = $1 AND a.status <> 'removed'
          ORDER BY a.work_date, a.shift_slot, a.status, u.last_name, u.first_name`,
        [schedule.id],
      )
    : [];
  const breaks = schedule
    ? await many(client, 'SELECT user_id, work_date, starts_at, ends_at, minutes FROM break_assignments WHERE schedule_id = $1', [schedule.id])
    : [];
  const employees = [...ctx.employees.values()]
    .filter((e) => e.branchIds.includes(branchId))
    .map((e) => {
      const mine = [...ctx.assignments, ...ctx.externalAssignments].filter((a) => a.userId === e.id && a.date >= ctx.dates[0] && a.date <= ctx.dates[6]);
      const byDate = new Map<string, Assignment[]>();
      for (const a of mine) byDate.set(a.date, [...(byDate.get(a.date) ?? []), a]);
      let minutes = 0;
      for (const items of byDate.values()) minutes += dayPlan(ctx, items).workMinutes;
      return {
        id: e.id,
        name: e.name,
        skills: e.skills.map((s) => s.skillId),
        weekWorkMinutes: minutes,
        contractWeeklyMinutes: e.contractWeeklyMinutes,
        availableCount: [...(ctx.availability.get(e.id)?.values() ?? [])].filter((x) => x === 'available').length,
        submitted: Boolean(ctx.availability.get(e.id)?.size),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    branchId,
    weekStart,
    dates: ctx.dates,
    templates: ctx.templates,
    schedule: schedule
      ? {
          id: schedule.id,
          status: schedule.status,
          revision: schedule.revision,
          publishedRevision: schedule.published_revision,
          publishedVersionNo: schedule.published_version_no,
          publishedAt: schedule.published_at,
          availabilityDeadline: schedule.availability_deadline,
          hasUnpublishedChanges: schedule.status === 'draft' || schedule.published_revision !== schedule.revision,
        }
      : null,
    requirements: ctx.requirements,
    assignments: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: `${r.first_name} ${r.last_name}`,
      employeeNumber: r.employee_number,
      date: r.work_date,
      slot: r.shift_slot,
      roleSkillId: r.role_skill_id,
      primarySkill: r.primary_skill,
      status: r.status,
      source: r.source,
      cover: r.cover_id ? { id: r.cover_id, status: r.cover_status, kind: r.cover_kind } : null,
    })),
    breaks: breaks.map((b) => ({
      userId: b.user_id,
      date: b.work_date,
      start: localTimeOf(new Date(b.starts_at).getTime()),
      end: localTimeOf(new Date(b.ends_at).getTime()),
      minutes: b.minutes,
    })),
    coverage: validation.coverage,
    issues: validation.issues,
    employees,
    policy: {
      versionId: ctx.policy.versionId,
      maxDailyWorkMinutes: ctx.policy.maxDailyWorkMinutes,
      staffingCountsBreaks: ctx.policy.staffingCountsBreaks,
    },
  };
}

export async function monthView(client: Db, branchId: string, from: string, to: string) {
  const counts = await many(
    client,
    `SELECT a.work_date, a.shift_slot, count(*)::int AS n FROM shift_assignments a
      WHERE a.branch_id = $1 AND a.status = 'active' AND a.work_date BETWEEN $2 AND $3 GROUP BY 1, 2`,
    [branchId, from, to],
  );
  const roleCounts = await many(
    client,
    `SELECT a.work_date, a.shift_slot, a.role_skill_id, count(*)::int AS n FROM shift_assignments a
      WHERE a.branch_id = $1 AND a.status = 'active' AND a.role_skill_id IS NOT NULL AND a.work_date BETWEEN $2 AND $3 GROUP BY 1, 2, 3`,
    [branchId, from, to],
  );
  const reqs = await many(client, 'SELECT weekday, shift_slot, min_staff FROM staffing_requirements WHERE branch_id = $1', [branchId]);
  const skillReqs = await many(client, 'SELECT weekday, shift_slot, skill_id, min_count FROM skill_requirements WHERE branch_id = $1', [branchId]);
  const schedules = await many(
    client,
    `SELECT id, week_start, status, revision, published_revision FROM schedules WHERE branch_id = $1 AND week_start BETWEEN $2 AND $3`,
    [branchId, weekStartOf(from), to],
  );
  const covers = await many(
    client,
    `SELECT work_date, count(*)::int AS n FROM cover_requests WHERE branch_id = $1 AND status IN ('open', 'pending') AND work_date BETWEEN $2 AND $3 GROUP BY 1`,
    [branchId, from, to],
  );
  const sick = await many(
    client,
    `SELECT work_date, count(*)::int AS n FROM sickness_reports WHERE branch_id = $1 AND work_date BETWEEN $2 AND $3 GROUP BY 1`,
    [branchId, from, to],
  );
  const templates = await loadTemplates(client);
  const days = eachDate(from, to).map((date) => {
    const wd = isoWeekday(date);
    const shifts = templates.map((t) => {
      const assigned = counts.find((c) => c.work_date === date && c.shift_slot === t.slot)?.n ?? 0;
      const minStaff = reqs.find((r) => r.weekday === wd && r.shift_slot === t.slot)?.min_staff ?? 0;
      const skillGaps = skillReqs
        .filter((r) => r.weekday === wd && r.shift_slot === t.slot)
        .filter((r) => (roleCounts.find((c) => c.work_date === date && c.shift_slot === t.slot && c.role_skill_id === r.skill_id)?.n ?? 0) < r.min_count).length;
      return { slot: t.slot, assigned, minStaff, skillGaps };
    });
    const sch = schedules.find((s) => s.week_start === weekStartOf(date));
    return {
      date,
      shifts,
      scheduleStatus: sch ? (sch.status === 'published' && sch.revision !== sch.published_revision ? 'changed' : sch.status) : 'none',
      openCover: covers.find((c) => c.work_date === date)?.n ?? 0,
      sickness: sick.find((c) => c.work_date === date)?.n ?? 0,
    };
  });
  return { branchId, from, to, templates, days };
}
