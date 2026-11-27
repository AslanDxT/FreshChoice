import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../../src/jobs.js';
import { addDays } from '../../src/lib/time.js';
import { activeEmployee, db, futureWeek, setAllRequirements, setupWorld, startApp, submitWeek, type World } from './harness.js';

let env: Awaited<ReturnType<typeof startApp>>;
let world: World;
let A: string;
type Emp = Awaited<ReturnType<typeof activeEmployee>>;
let manager: Emp;
let requester: Emp;
let colleague1: Emp;
let colleague2: Emp;
let unavailable: Emp;
let sickOne: Emp;
const week = futureWeek(2);
const day = addDays(week, 2);
let swapAssignment: string;
let sickAssignment: string;

beforeAll(async () => {
  env = await startApp('cover');
  world = await setupWorld(env.app, 1, 1);
  A = world.branches[0].id;
  await setAllRequirements(world.admin, A, 0);
  manager = await activeEmployee(env.app, world.admin, { employeeNumber: 'CM', homeBranchId: A, accountType: 'branch_manager', managerBranchIds: [A], schedulable: false });
  requester = await activeEmployee(env.app, world.admin, { employeeNumber: 'CR', homeBranchId: A });
  colleague1 = await activeEmployee(env.app, world.admin, { employeeNumber: 'C1', homeBranchId: A });
  colleague2 = await activeEmployee(env.app, world.admin, { employeeNumber: 'C2', homeBranchId: A });
  unavailable = await activeEmployee(env.app, world.admin, { employeeNumber: 'CU', homeBranchId: A });
  sickOne = await activeEmployee(env.app, world.admin, { employeeNumber: 'CS', homeBranchId: A });
  for (const e of [requester, colleague1, colleague2, sickOne]) await submitWeek(e.client, week);
  await submitWeek(unavailable.client, week, 'unavailable');
  const a1 = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: requester.id, date: day, slot: 2 });
  const a2 = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: sickOne.id, date: day, slot: 3 });
  swapAssignment = a1.body.id;
  sickAssignment = a2.body.id;
  const v = await manager.client.post(`/api/schedules/${a1.body.scheduleId}/validate`);
  const p = await manager.client.post(`/api/schedules/${a1.body.scheduleId}/publish`, { revision: v.body.revision });
  if (p.status !== 200) throw new Error(JSON.stringify(p.body));
});
afterAll(async () => env.stop());

describe('cover request (case 11)', () => {
  let requestId: string;

  it('creates a request visible only to eligible colleagues', async () => {
    const r = await requester.client.post('/api/me/cover-requests', { assignmentId: swapAssignment, note: 'Family event' });
    expect(r.status).toBe(200);
    requestId = r.body.id;
    expect(r.body.eligibleCount).toBe(3); // colleague1, colleague2, sickOne (unavailable excluded)
    const seen1 = await colleague1.client.get('/api/cover/opportunities');
    expect(seen1.body.map((o: any) => o.id)).toContain(requestId);
    const seenU = await unavailable.client.get('/api/cover/opportunities');
    expect(seenU.body.map((o: any) => o.id)).not.toContain(requestId);
    const notes = await colleague1.client.get('/api/notifications');
    expect(notes.body.some((n: any) => n.type === 'cover_opportunity')).toBe(true);
  });

  it('refuses a duplicate request and keeps the original assignment active', async () => {
    const again = await requester.client.post('/api/me/cover-requests', { assignmentId: swapAssignment });
    expect(again.status).toBe(409);
    const row = await db().query('SELECT status FROM shift_assignments WHERE id = $1', [swapAssignment]);
    expect(row.rows[0].status).toBe('active');
  });

  it('lets only one of two simultaneous claims win (case 12)', async () => {
    const [x, y] = await Promise.all([colleague1.client.post(`/api/cover-requests/${requestId}/claim`), colleague2.client.post(`/api/cover-requests/${requestId}/claim`)]);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    expect([x.body.result, y.body.result].sort()).toEqual(['claimed', 'interested']);
    const claims = await db().query(`SELECT count(*)::int AS n FROM cover_claims WHERE cover_request_id = $1 AND status = 'claimed'`, [requestId]);
    expect(claims.rows[0].n).toBe(1);
    const req = await db().query('SELECT status FROM cover_requests WHERE id = $1', [requestId]);
    expect(req.rows[0].status).toBe('pending');
  });

  it('refuses a claim from an unavailable employee', async () => {
    const r = await unavailable.client.post(`/api/cover-requests/${requestId}/claim`);
    expect(r.status).toBe(422);
  });

  it('approves the replacement atomically and informs both employees', async () => {
    const list = await manager.client.get(`/api/cover-requests?branchId=${A}`);
    const req = list.body.find((r: any) => r.id === requestId);
    const winner = req.claimedBy;
    const r = await manager.client.post(`/api/cover-requests/${requestId}/approve`, { userId: winner });
    expect(r.status).toBe(200);
    const orig = await db().query('SELECT status FROM shift_assignments WHERE id = $1', [swapAssignment]);
    expect(orig.rows[0].status).toBe('replaced');
    const history = await db().query('SELECT * FROM replacement_history WHERE cover_request_id = $1', [requestId]);
    expect(history.rows).toHaveLength(1);
    // the published version now shows the replacement, not the requester
    const reqShifts = await requester.client.get(`/api/me/shifts?from=${week}&to=${addDays(week, 6)}`);
    expect(reqShifts.body.shifts.find((s: any) => s.assignmentId === swapAssignment).status).toBe('replaced');
    const winnerClient = winner === colleague1.id ? colleague1 : colleague2;
    const winShifts = await winnerClient.client.get(`/api/me/shifts?from=${week}&to=${addDays(week, 6)}`);
    expect(winShifts.body.shifts.some((s: any) => s.date === day && s.slot === 2 && s.status === 'active')).toBe(true);
    const n1 = await requester.client.get('/api/notifications');
    expect(n1.body.some((n: any) => n.type === 'cover_approved')).toBe(true);
    const n2 = await winnerClient.client.get('/api/notifications');
    expect(n2.body.some((n: any) => n.type === 'cover_approved')).toBe(true);
    // a second approval cannot create a duplicate replacement
    const again = await manager.client.post(`/api/cover-requests/${requestId}/approve`, { userId: winner });
    expect(again.status).toBe(409);
  });
});

describe('sickness report', () => {
  it('records sickness, keeps history, notifies the manager and opens a replacement request', async () => {
    const r = await sickOne.client.post('/api/me/sickness', { assignmentId: sickAssignment, includeRestOfDay: true, note: 'Will call tomorrow' });
    expect(r.status).toBe(200);
    expect(r.body.message).toContain('manager has been notified');
    const a = await db().query('SELECT status FROM shift_assignments WHERE id = $1', [sickAssignment]);
    expect(a.rows[0].status).toBe('sick'); // not deleted
    const cr = await db().query(`SELECT kind, status FROM cover_requests WHERE assignment_id = $1`, [sickAssignment]);
    expect(cr.rows[0]).toEqual({ kind: 'sickness', status: 'open' });
    const n = await manager.client.get('/api/notifications');
    expect(n.body.some((x: any) => x.type === 'sickness_reported')).toBe(true);
    const reports = await manager.client.get(`/api/sickness?branchId=${A}`);
    expect(reports.body[0].shifts).toHaveLength(1);
    // the sick employee is now ineligible for other work that day
    const extra = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: sickOne.id, date: day, slot: 1 });
    expect(extra.status).toBe(422);
    expect(extra.body.error.details.violations.map((v: any) => v.code)).toContain('SICK');
  });

  it('lets the manager assign a replacement directly', async () => {
    const cr = await db().query(`SELECT id FROM cover_requests WHERE assignment_id = $1`, [sickAssignment]);
    const cands = await manager.client.get(`/api/cover-requests/${cr.rows[0].id}/candidates`);
    const eligible = cands.body.filter((c: any) => c.eligible).map((c: any) => c.userId);
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible).not.toContain(unavailable.id);
    const r = await manager.client.post(`/api/cover-requests/${cr.rows[0].id}/approve`, { userId: eligible[0] });
    expect(r.status).toBe(200);
    const versions = await db().query(`SELECT reason FROM schedule_versions ORDER BY version_no`);
    expect(versions.rows.map((v) => v.reason)).toEqual(['publish', 'cover', 'sickness', 'cover']);
  });
});

describe('maintenance job', () => {
  it('cancels open requests whose shift has started', async () => {
    // Make a fresh request, then run the job with a clock set after the shift starts.
    const extraDay = addDays(week, 4);
    const a = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: colleague2.id, date: extraDay, slot: 1 });
    const v = await manager.client.post(`/api/schedules/${a.body.scheduleId}/validate`);
    await manager.client.post(`/api/schedules/${a.body.scheduleId}/publish`, { revision: v.body.revision });
    const cr = await colleague2.client.post('/api/me/cover-requests', { assignmentId: a.body.id });
    expect(cr.status).toBe(200);
    // Shifts are protected by a composite foreign key, so the start time cannot be faked in the
    // database; instead the job runs with a clock set just after the shift begins.
    const start = await db().query('SELECT starts_at FROM shift_assignments WHERE id = $1', [a.body.id]);
    const res = await runMaintenance(undefined, new Date(start.rows[0].starts_at.getTime() + 60000));
    expect(res.expired).toBeGreaterThanOrEqual(1);
    const row = await db().query('SELECT status FROM cover_requests WHERE id = $1', [cr.body.id]);
    expect(row.rows[0].status).toBe('cancelled');
  });
});

describe('role needed by a replacement', () => {
  it('lets a non-cashier cover a cashier when another cashier keeps the minimum', async () => {
    const cashier = world.skills.find((s: any) => s.name === 'Cashier')!.id;
    const target = addDays(week, 5);
    const weekday = 6; // Saturday
    for (const e of [requester, colleague2]) {
      expect((await world.admin.put(`/api/employees/${e.id}/skills`, { skills: [{ skillId: cashier, isPrimary: true }] })).status).toBe(200);
    }
    const staffing = [];
    for (let wd = 1; wd <= 7; wd++) for (let slot = 1; slot <= 4; slot++) staffing.push({ weekday: wd, slot, minStaff: wd === weekday && slot === 1 ? 2 : 0 });
    const req = await world.admin.put(`/api/branches/${A}/requirements`, { staffing, skills: [{ weekday, slot: 1, skillId: cashier, minCount: 1 }] });
    expect(req.status).toBe(200);
    const a = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: requester.id, date: target, slot: 1, roleSkillId: cashier });
    const b = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: colleague2.id, date: target, slot: 1, roleSkillId: cashier });
    expect([a.status, b.status]).toEqual([200, 200]);
    const v = await manager.client.post(`/api/schedules/${a.body.scheduleId}/validate`);
    expect((await manager.client.post(`/api/schedules/${a.body.scheduleId}/publish`, { revision: v.body.revision })).status).toBe(200);
    const cr = await requester.client.post('/api/me/cover-requests', { assignmentId: a.body.id });
    expect(cr.status).toBe(200);
    const cands = await manager.client.get(`/api/cover-requests/${cr.body.id}/candidates`);
    expect(cands.body.find((c: any) => c.userId === colleague1.id)?.eligible).toBe(true); // no cashier skill, still eligible
    const ok = await manager.client.post(`/api/cover-requests/${cr.body.id}/approve`, { userId: colleague1.id });
    expect(ok.status).toBe(200);
    const row = await db().query('SELECT role_skill_id FROM shift_assignments WHERE id = $1', [ok.body.replacementAssignmentId]);
    expect(row.rows[0].role_skill_id).toBeNull(); // works as general staff
    const after = await manager.client.post(`/api/schedules/${a.body.scheduleId}/validate`);
    expect(after.body.issues.filter((i: any) => i.code === 'SKILL_SHORTAGE')).toEqual([]);
  });
});

describe('manager-chosen replacements', () => {
  it('cannot assign someone who never submitted availability, unless they offered themselves', async () => {
    const silent = await activeEmployee(env.app, world.admin, { employeeNumber: 'CSILENT', homeBranchId: A });
    const target = addDays(week, 6);
    const a = await manager.client.post(`/api/branches/${A}/weeks/${week}/assignments`, { userId: colleague1.id, date: target, slot: 2 });
    expect(a.status).toBe(200);
    const v = await manager.client.post(`/api/schedules/${a.body.scheduleId}/validate`);
    expect((await manager.client.post(`/api/schedules/${a.body.scheduleId}/publish`, { revision: v.body.revision })).status).toBe(200);
    const cr = await colleague1.client.post('/api/me/cover-requests', { assignmentId: a.body.id });
    expect(cr.status).toBe(200);
    const cands = await manager.client.get(`/api/cover-requests/${cr.body.id}/candidates`);
    const s = cands.body.find((c: any) => c.userId === silent.id);
    expect(s.eligible).toBe(false);
    expect(s.reasons.join(' ')).toContain('not submitted availability');
    expect((await manager.client.post(`/api/cover-requests/${cr.body.id}/approve`, { userId: silent.id })).status).toBe(422);
    // offering is an explicit statement of availability
    const offer = await silent.client.post(`/api/cover-requests/${cr.body.id}/claim`);
    expect(offer.body.result).toBe('claimed');
    expect((await manager.client.post(`/api/cover-requests/${cr.body.id}/approve`, { userId: silent.id })).status).toBe(200);
  });
});
