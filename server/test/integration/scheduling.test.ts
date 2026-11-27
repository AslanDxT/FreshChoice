import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/lib/time.js';
import { activeEmployee, db, futureWeek, setAllRequirements, setupWorld, startApp, submitWeek, type World } from './harness.js';

let env: Awaited<ReturnType<typeof startApp>>;
let world: World;
let A: string;
let B: string;
type Emp = Awaited<ReturnType<typeof activeEmployee>>;
let manager: Emp;
let managerB: Emp;
const staff: Emp[] = [];
let shared: Emp;
const week = futureWeek(3);

beforeAll(async () => {
  env = await startApp('sched');
  world = await setupWorld(env.app, 2, 2);
  [A, B] = world.branches.map((b) => b.id);
  manager = await activeEmployee(env.app, world.admin, { employeeNumber: 'MGR-A', homeBranchId: A, accountType: 'branch_manager', managerBranchIds: [A], schedulable: false });
  managerB = await activeEmployee(env.app, world.admin, { employeeNumber: 'MGR-B', homeBranchId: B, accountType: 'branch_manager', managerBranchIds: [B], schedulable: false });
  const cashier = world.skills.find((s: any) => s.name === 'Cashier')!.id;
  for (let i = 0; i < 6; i++) {
    staff.push(await activeEmployee(env.app, world.admin, { employeeNumber: `S${i}`, homeBranchId: A, skills: i < 2 ? [{ skillId: cashier, isPrimary: true }] : [] }));
  }
  shared = await activeEmployee(env.app, world.admin, { employeeNumber: 'SHARED', homeBranchId: A, extraBranchIds: [B] });
  // Small synthetic requirement so a week can be fully staffed in tests: 1 per shift, 1 cashier on Monday shift 1.
  await setAllRequirements(world.admin, A, 1);
  await setAllRequirements(world.admin, B, 0);
});
afterAll(async () => env.stop());

describe('availability', () => {
  it('saves a weekly submission and shows it to the manager', async () => {
    for (const s of staff) expect((await submitWeek(s.client, week)).status).toBe(200);
    const overview = await manager.client.get(`/api/availability/overview?branchId=${A}&from=${week}&to=${addDays(week, 6)}`);
    expect(overview.status).toBe(200);
    const row = overview.body.employees.find((e: any) => e.id === staff[0].id);
    expect(row.entries).toHaveLength(28);
    const shared = overview.body.employees.find((e: any) => e.employeeNumber === 'SHARED');
    expect(shared.entries).toHaveLength(0); // not submitted is reported, not assumed
  });

  it('saves a monthly submission', async () => {
    const month = addDays(week, 35).slice(0, 7);
    const r = await staff[5].client.post('/api/me/availability', { periodType: 'month', startDate: `${month}-01`, entries: [{ date: `${month}-15`, slot: 2, status: 'unavailable', note: 'Course' }] });
    expect(r.status).toBe(200);
  });

  it('rejects availability for the past', async () => {
    const r = await staff[0].client.post('/api/me/availability', { periodType: 'week', startDate: futureWeek(-1), entries: [{ date: futureWeek(-1), slot: 1, status: 'available' }] });
    expect(r.status).toBe(400);
  });
});

describe('manual scheduling', () => {
  it('rejects unavailable and unsubmitted employees with explanations', async () => {
    await staff[4].client.post('/api/me/availability', { periodType: 'week', startDate: week, entries: [{ date: week, slot: 4, status: 'unavailable' }] });
    const un = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: staff[4].id, date: week, slot: 4 });
    expect(un.status).toBe(422);
    expect(un.body.error.details.violations[0].code).toBe('UNAVAILABLE');
    const ns = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: shared.id, date: week, slot: 1 });
    expect(ns.status).toBe(422);
    expect(ns.body.error.details.violations[0].code).toBe('AVAILABILITY_UNKNOWN');
  });

  it('rejects a role the employee does not hold', async () => {
    const cashier = world.skills.find((s: any) => s.name === 'Cashier')!.id;
    const r = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: staff[3].id, date: week, slot: 1, roleSkillId: cashier });
    expect(r.status).toBe(422);
    expect(r.body.error.details.violations.map((v: any) => v.code)).toContain('SKILL_MISSING');
  });

  it('enforces the daily limit and stores breaks for consecutive shifts', async () => {
    const day = addDays(week, 1);
    for (const slot of [1, 2, 3]) {
      const r = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: staff[2].id, date: day, slot });
      expect(r.status).toBe(200);
    }
    const fourth = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: staff[2].id, date: day, slot: 4 });
    expect(fourth.status).toBe(422);
    expect(fourth.body.error.details.violations.map((v: any) => v.code)).toContain('DAILY_LIMIT');
    const view = await manager.client.get(`/api/branches/${A}/weeks/${week}`);
    const brk = view.body.breaks.filter((b: any) => b.userId === staff[2].id && b.date === day);
    expect(brk).toHaveLength(1);
    expect(brk[0].minutes).toBe(60);
  });

  it('prevents double booking across branches, also under concurrent requests (two managers at once)', async () => {
    await submitWeek(shared.client, week);
    const day = addDays(week, 2);
    const [x, y] = await Promise.all([
      manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: shared.id, date: day, slot: 2 }),
      managerB.client.post(`/api/branches/${B}/weeks/${week}/assignments`, { userId: shared.id, date: day, slot: 2 }),
    ]);
    const statuses = [x.status, y.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(409);
    const rows = await db().query(`SELECT count(*)::int AS n FROM shift_assignments WHERE user_id = $1 AND work_date = $2 AND status = 'active'`, [shared.id, day]);
    expect(rows.rows[0].n).toBe(1);
  });
});

describe('generation, validation and publication', () => {
  let scheduleId: string;
  let revision: number;

  it('generates a draft that respects availability', async () => {
    const r = await manager.client.post(`/api/branches/${A}/weeks/${week}/generate`, { mode: 'fill' });
    expect(r.status).toBe(200);
    scheduleId = r.body.scheduleId;
    const view = await manager.client.get(`/api/branches/${A}/weeks/${week}`);
    expect(view.body.schedule.status).toBe('draft');
    const forStaff4 = view.body.assignments.filter((a: any) => a.userId === staff[4].id && a.date === week && a.slot === 4);
    expect(forStaff4).toHaveLength(0);
    // every shift reaches the minimum of 1
    expect(view.body.coverage.every((c: any) => c.assigned >= 1)).toBe(true);
    revision = view.body.schedule.revision;
  });

  it('keeps the draft invisible to employees', async () => {
    const r = await staff[0].client.get(`/api/me/shifts?from=${week}&to=${addDays(week, 6)}`);
    expect(r.body.shifts).toHaveLength(0);
  });

  it('refuses to publish a stale revision', async () => {
    const r = await manager.client.post(`/api/schedules/${scheduleId}/publish`, { revision: revision - 1 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STALE_REVISION');
  });

  it('refuses to publish with validation errors', async () => {
    const cashier = world.skills.find((s: any) => s.name === 'Cashier')!.id;
    await setAllRequirements(world.admin, A, 1, [{ skillId: cashier, minCount: 1 }]);
    const v = await manager.client.post(`/api/schedules/${scheduleId}/validate`);
    const errors = v.body.issues.filter((i: any) => i.severity === 'error');
    expect(errors.some((e: any) => e.code === 'SKILL_SHORTAGE')).toBe(true);
    const r = await manager.client.post(`/api/schedules/${scheduleId}/publish`, { revision: v.body.revision });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    await setAllRequirements(world.admin, A, 1);
  });

  it('publishes, notifies employees and shows confirmed shifts', async () => {
    const v = await manager.client.post(`/api/schedules/${scheduleId}/validate`);
    expect(v.body.issues.filter((i: any) => i.severity === 'error')).toEqual([]);
    const r = await manager.client.post(`/api/schedules/${scheduleId}/publish`, { revision: v.body.revision });
    expect(r.status).toBe(200);
    expect(r.body.versionNo).toBe(1);
    const mine = await staff[2].client.get(`/api/me/shifts?from=${week}&to=${addDays(week, 6)}`);
    expect(mine.body.shifts.length).toBeGreaterThan(0);
    const n = await staff[2].client.get('/api/notifications');
    expect(n.body.some((x: any) => x.type === 'schedule_published')).toBe(true);
  });

  it('keeps edits private until republished, then versions and notifies only affected staff', async () => {
    const view = await manager.client.get(`/api/branches/${A}/weeks/${week}`);
    const target = view.body.assignments.find((a: any) => a.userId === staff[2].id && a.slot === 3);
    expect((await manager.client.del(`/api/assignments/${target.id}`)).status).toBe(200);
    // keep the shift staffed: add the best valid candidate the engine suggests
    const cands = await manager.client.get(`/api/branches/${A}/weeks/${week}/candidates?date=${target.date}&slot=3`);
    const pick = cands.body.find((c: any) => c.feasible && !c.warnings.length && c.userId !== staff[2].id);
    expect(pick).toBeTruthy();
    expect((await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: pick.userId, date: target.date, slot: 3 })).status).toBe(200);
    // still visible to the employee (published version unchanged)
    const before = await staff[2].client.get(`/api/me/shifts?from=${week}&to=${addDays(week, 6)}`);
    expect(before.body.shifts.some((s: any) => s.assignmentId === target.id)).toBe(true);
    const v = await manager.client.post(`/api/schedules/${scheduleId}/validate`);
    const pub = await manager.client.post(`/api/schedules/${scheduleId}/publish`, { revision: v.body.revision });
    expect(pub.status, JSON.stringify(pub.body).slice(0, 1500)).toBe(200);
    expect(pub.body.versionNo).toBe(2);
    const after = await staff[2].client.get(`/api/me/shifts?from=${week}&to=${addDays(week, 6)}`);
    expect(after.body.shifts.some((s: any) => s.assignmentId === target.id)).toBe(false);
    const n = await staff[2].client.get('/api/notifications');
    expect(n.body.some((x: any) => x.type === 'schedule_changed')).toBe(true);
    // history is retained
    const versions = await manager.client.get(`/api/schedules/${scheduleId}/versions`);
    expect(versions.body.map((x: any) => x.versionNo)).toEqual([2, 1]);
    const removed = await db().query('SELECT status FROM shift_assignments WHERE id = $1', [target.id]);
    expect(removed.rows[0].status).toBe('removed');
  });

  it('does not let an employee mark a confirmed shift unavailable', async () => {
    const mine = await staff[0].client.get(`/api/me/shifts?from=${week}&to=${addDays(week, 6)}`);
    const s = mine.body.shifts[0];
    const r = await staff[0].client.post('/api/me/availability', { periodType: 'week', startDate: week, entries: [{ date: s.date, slot: s.slot, status: 'unavailable' }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ASSIGNED_SHIFT');
  });
});

describe('daylight saving time', () => {
  it('stores real instants for shifts in the week the clocks go forward', async () => {
    // Week of Monday 2027-03-22; the switch is on Sunday 2027-03-28.
    const dstWeek = '2027-03-22';
    await submitWeek(staff[0].client, dstWeek);
    const r = await manager.client.post(`/api/branches/${A}/weeks/${dstWeek}/assignments`, { userId: staff[0].id, date: '2027-03-28', slot: 1 });
    expect(r.status).toBe(200);
    const rows = await db().query(
      `SELECT work_date, starts_at, ends_at FROM shifts s JOIN schedules sc ON sc.id = s.schedule_id
        WHERE sc.week_start = $1 AND sc.branch_id = $2 AND s.shift_slot = 1 AND s.work_date IN ('2027-03-27', '2027-03-28') ORDER BY work_date`,
      [dstWeek, A],
    );
    expect(rows.rows[0].starts_at.toISOString()).toBe('2027-03-27T08:00:00.000Z'); // CET, UTC+1
    expect(rows.rows[1].starts_at.toISOString()).toBe('2027-03-28T07:00:00.000Z'); // CEST, UTC+2
    for (const row of rows.rows) expect(row.ends_at - row.starts_at).toBe(3 * 3600 * 1000);
  });
});

describe('policy changes', () => {
  it('creates a new audited policy version without touching published schedules', async () => {
    const current = (await world.admin.get('/api/policy')).body;
    const body = {
      maxDailyWorkMinutes: current.maxDailyWorkMinutes,
      maxWeeklyWorkMinutes: 3900,
      minDailyRestMinutes: current.minDailyRestMinutes,
      maxConsecutiveWorkDays: current.maxConsecutiveWorkDays,
      breaksPaid: false,
      staffingCountsBreaks: true,
      singleBranchPerDay: true,
      breakGranularityMinutes: 15,
      fairnessLookbackWeeks: 8,
      weights: current.weights,
      breakRules: current.breakRules,
      note: 'Test change',
    };
    const r = await world.admin.put('/api/policy', body);
    expect(r.status).toBe(200);
    expect(r.body.versionNo).toBe(2);
    expect(r.body.warnings.some((w: string) => w.includes('60 hours'))).toBe(true);
    const audit = await db().query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'policy.updated'`);
    expect(audit.rows[0].n).toBe(1);
    const versions = await db().query('SELECT DISTINCT policy_version_id FROM schedule_versions');
    expect(versions.rows.map((x) => x.policy_version_id)).toEqual([1]);
  });
});
