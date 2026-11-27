import { describe, expect, it } from 'vitest';
import { localTimeOf, localToUtcMs, tzOffsetMinutes } from '../../src/lib/time.js';
import { placeBreaksForDay } from '../../src/scheduling/breaks.js';
import { generateSchedule, listCandidates } from '../../src/scheduling/generate.js';
import { AssignmentIndex, checkCandidate, dayPlan } from '../../src/scheduling/rules.js';
import { validateSchedule } from '../../src/scheduling/validate.js';
import { BAKERY, BRANCH, CASHIER, OTHER_BRANCH, asg, ctx, employee, policy, rng, week } from './helpers.js';

const MON = '2026-11-23';
const TUE = '2026-11-24';

const PER_EMPLOYEE_ERRORS = new Set([
  'ASSIGNED_UNAVAILABLE',
  'ASSIGNED_WITHOUT_AVAILABILITY',
  'ALREADY_ASSIGNED',
  'DAILY_LIMIT',
  'WEEKLY_LIMIT',
  'REST_PERIOD',
  'CONSECUTIVE_DAYS',
  'SKILL_MISSING',
  'NOT_ELIGIBLE_BRANCH',
  'OTHER_BRANCH_SAME_DAY',
  'SICK',
  'ACCOUNT_INACTIVE',
  'LATEST_END',
]);

const ids = (n: number, prefix = 'e') => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);

describe('1. fully staffed shift with suitable skills', () => {
  it('has no staffing or skill errors', () => {
    const emps = ids(10).map((id, i) => employee(id, { skills: i < 3 ? [{ skillId: CASHIER, validUntil: null }] : [] }));
    const assignments = emps.map((e, i) => asg(e.id, MON, 1, i < 3 ? CASHIER : null));
    const c = ctx({
      employees: emps,
      availableAll: emps.map((e) => e.id),
      onlyDates: [MON],
      onlySlots: [1],
      minStaff: 10,
      skillNeeds: [{ skillId: CASHIER, minCount: 3 }],
      assignments,
    });
    const { issues, coverage } = validateSchedule(c);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(coverage.find((x) => x.date === MON && x.slot === 1)?.ok).toBe(true);
  });
});

describe('2. shift with insufficient employees', () => {
  it('fills what it can and explains the shortage', () => {
    const emps = ids(8).map((id) => employee(id));
    const avail = emps.slice(0, 5).map((e) => [e.id, MON, 1] as [string, string, number]);
    const unavail = emps.slice(5, 7).map((e) => [e.id, MON, 1] as [string, string, number]);
    const c = ctx({ employees: emps, available: avail, unavailable: unavail, onlyDates: [MON], onlySlots: [1], minStaff: 10 });
    const r = generateSchedule(c, 'fill');
    expect(r.added).toHaveLength(5);
    const issue = r.issues.find((i) => i.code === 'UNDERSTAFFED');
    expect(issue?.message).toContain('5 of 10 staff');
    expect(issue?.message).toContain('2 are unavailable');
    expect(issue?.message).toContain('1 have not submitted availability');
  });
});

describe('3/4. insufficient cashier and bakery coverage', () => {
  it('reports each missing role separately and still fills headcount with general staff', () => {
    const emps = [
      employee('c1', { skills: [{ skillId: CASHIER, validUntil: null }] }),
      employee('b1', { skills: [{ skillId: BAKERY, validUntil: '2026-01-01' }] }), // expired qualification
      ...ids(6, 'g').map((id) => employee(id)),
    ];
    const c = ctx({
      employees: emps,
      availableAll: emps.map((e) => e.id),
      onlyDates: [MON],
      onlySlots: [2],
      minStaff: 6,
      skillNeeds: [
        { skillId: CASHIER, minCount: 2 },
        { skillId: BAKERY, minCount: 1 },
      ],
    });
    const r = generateSchedule(c, 'fill');
    const shortages = r.issues.filter((i) => i.code === 'SKILL_SHORTAGE');
    expect(shortages.map((s) => s.skillId).sort()).toEqual([BAKERY, CASHIER].sort());
    expect(shortages.find((s) => s.skillId === CASHIER)?.message).toContain('1 of 2 Cashier');
    expect(shortages.find((s) => s.skillId === BAKERY)?.message).toContain('0 of 1 Bakery');
    expect(r.assignments.filter((a) => a.date === MON && a.slot === 2)).toHaveLength(6);
    expect(r.issues.find((i) => i.code === 'UNDERSTAFFED')).toBeUndefined();
    // the expired bakery qualification is never used as a role
    expect(r.assignments.some((a) => a.roleSkillId === BAKERY)).toBe(false);
  });
});

describe('5/6. unavailable and unsubmitted employees', () => {
  it('rejects both, never schedules them automatically, and says why', () => {
    const c = ctx({
      employees: [employee('u'), employee('n'), employee('a')],
      unavailable: [['u', MON, 1]],
      available: [['a', MON, 1]],
      onlyDates: [MON],
      onlySlots: [1],
      minStaff: 3,
    });
    const index = new AssignmentIndex([]);
    expect(checkCandidate(c, index, asg('u', MON, 1)).map((v) => v.code)).toContain('UNAVAILABLE');
    expect(checkCandidate(c, index, asg('n', MON, 1)).map((v) => v.code)).toContain('AVAILABILITY_UNKNOWN');
    const r = generateSchedule(c, 'fill');
    expect(r.added.map((a) => a.userId)).toEqual(['a']);
    const list = listCandidates(c, MON, 1, null);
    expect(list.find((x) => x.userId === 'n')?.availability).toBe('not_submitted');
    expect(list.find((x) => x.userId === 'u')?.feasible).toBe(false);
  });
});

describe('7. already assigned to an overlapping shift', () => {
  it('blocks a second assignment at the same time, also across branches', () => {
    const e = employee('x', { branchIds: [BRANCH, OTHER_BRANCH] });
    const c = ctx({ employees: [e], availableAll: ['x'], external: [asg('x', MON, 1, null, OTHER_BRANCH)] });
    const codes = checkCandidate(c, new AssignmentIndex([c.externalAssignments]), asg('x', MON, 1)).map((v) => v.code);
    expect(codes).toContain('ALREADY_ASSIGNED');
    // a different shift the same day is still blocked by the single-branch-per-day policy
    const codes2 = checkCandidate(c, new AssignmentIndex([c.externalAssignments]), asg('x', MON, 3)).map((v) => v.code);
    expect(codes2).toContain('OTHER_BRANCH_SAME_DAY');
  });
});

describe('8. nine-hour daily limit', () => {
  const c = ctx({ employees: [employee('x')], availableAll: ['x'] });
  it('allows three consecutive shifts (9 h presence, 60 min break = 8 h work)', () => {
    const index = new AssignmentIndex([[asg('x', MON, 1), asg('x', MON, 2)]]);
    expect(checkCandidate(c, index, asg('x', MON, 3))).toEqual([]);
  });
  it('allows two consecutive plus one split shift (8 h 30)', () => {
    const index = new AssignmentIndex([[asg('x', MON, 1), asg('x', MON, 2)]]);
    expect(checkCandidate(c, index, asg('x', MON, 4))).toEqual([]);
    expect(dayPlan(c, [asg('x', MON, 1), asg('x', MON, 2), asg('x', MON, 4)]).workMinutes).toBe(510);
  });
  it('rejects a fourth shift (11 h of work)', () => {
    const index = new AssignmentIndex([[asg('x', MON, 1), asg('x', MON, 2), asg('x', MON, 3)]]);
    const v = checkCandidate(c, index, asg('x', MON, 4));
    expect(v.map((x) => x.code)).toContain('DAILY_LIMIT');
    expect(v.find((x) => x.code === 'DAILY_LIMIT')?.message).toContain('11 h');
  });
  it('applies a stricter working-time profile', () => {
    const young = employee('y', { limits: { ...employee('y').limits, maxDailyWorkMinutes: 480, latestEndTime: '20:00' } });
    const c2 = ctx({ employees: [young], availableAll: ['y'] });
    const index = new AssignmentIndex([[asg('y', MON, 1), asg('y', MON, 2)]]);
    expect(checkCandidate(c2, index, asg('y', MON, 3))).toEqual([]); // 8 h work
    expect(checkCandidate(c2, new AssignmentIndex([]), asg('y', MON, 4)).map((v) => v.code)).toContain('LATEST_END');
  });
});

describe('9/10. breaks for consecutive shifts', () => {
  it('gives 30 minutes for two consecutive shifts, inside the block and window', () => {
    const c = ctx({ employees: [employee('x')], availableAll: ['x'], policy: policy({ staffingCountsBreaks: false }) });
    const plan = dayPlan(c, [asg('x', MON, 1), asg('x', MON, 2)]);
    expect(plan.breakMinutes).toBe(30);
    expect(plan.workMinutes).toBe(330);
    const { breaks } = placeBreaksForDay(c, MON, [asg('x', MON, 1), asg('x', MON, 2)], new Map());
    expect(breaks).toHaveLength(1);
    expect(breaks[0].minutes).toBe(30);
    // centred on the 12:00 shift boundary
    expect(localTimeOf(breaks[0].startMs)).toBe('11:45');
    expect(localTimeOf(breaks[0].endMs)).toBe('12:15');
  });
  it('gives 60 minutes for three consecutive shifts', () => {
    const c = ctx({ employees: [employee('x')], availableAll: ['x'] });
    const plan = dayPlan(c, [asg('x', MON, 2), asg('x', MON, 3), asg('x', MON, 4)]);
    expect(plan.breakMinutes).toBe(60);
    expect(plan.workMinutes).toBe(480);
  });
  it('gives no consecutive-shift break for separate shifts', () => {
    const c = ctx({ employees: [employee('x')], availableAll: ['x'] });
    expect(dayPlan(c, [asg('x', MON, 1), asg('x', MON, 3)]).breakMinutes).toBe(0);
  });
  it('staggers breaks and reports coverage lost to breaks at exactly-minimum staffing', () => {
    const emps = ids(4).map((id) => employee(id));
    // everyone works 09:00-15:00, minimum 4 on the floor in both shifts
    const assignments = emps.flatMap((e) => [asg(e.id, MON, 1), asg(e.id, MON, 2)]);
    const c = ctx({ employees: emps, availableAll: emps.map((e) => e.id), onlyDates: [MON], onlySlots: [1, 2], minStaff: 4, assignments });
    const r = validateSchedule(c);
    const dayBreaks = r.breaks.filter((b) => b.date === MON);
    expect(dayBreaks).toHaveLength(4);
    // breaks do not all overlap
    const starts = new Set(dayBreaks.map((b) => b.startMs));
    expect(starts.size).toBeGreaterThan(1);
    expect(r.issues.some((i) => i.code === 'BREAK_COVERAGE')).toBe(true);
  });
  it('adds break relief when someone is available', () => {
    const emps = ids(6).map((id) => employee(id));
    const assignments = emps.slice(0, 4).flatMap((e) => [asg(e.id, MON, 1), asg(e.id, MON, 2)]);
    const c = ctx({ employees: emps, availableAll: emps.map((e) => e.id), onlyDates: [MON], onlySlots: [1, 2], minStaff: 4, assignments });
    const r = generateSchedule(c, 'fill');
    expect(r.added.length).toBeGreaterThan(0);
    expect(r.issues.some((i) => i.code === 'BREAK_COVERAGE')).toBe(false);
  });
});

describe('14. daylight-saving-time transitions', () => {
  it('converts local shift times correctly on both sides of the March switch', () => {
    // 2026-03-29: clocks go from 02:00 to 03:00 in Europe/Amsterdam
    expect(new Date(localToUtcMs('2026-03-28', '09:00')).toISOString()).toBe('2026-03-28T08:00:00.000Z');
    expect(new Date(localToUtcMs('2026-03-29', '09:00')).toISOString()).toBe('2026-03-29T07:00:00.000Z');
    expect(tzOffsetMinutes(Date.parse('2026-10-25T12:00:00Z'))).toBe(60);
    expect(tzOffsetMinutes(Date.parse('2026-10-24T12:00:00Z'))).toBe(120);
  });
  it('computes rest on real instants: 11 h across the spring-forward night', () => {
    const e = employee('x');
    const c = ctx({ weekStart: '2026-03-23', employees: [e], availableAll: ['x'], policy: policy() });
    const index = new AssignmentIndex([[asg('x', '2026-03-28', 4)]]);
    // 21:00 Saturday -> 09:00 Sunday is only 11 real hours; still meets the 11 h minimum
    expect(checkCandidate(c, index, asg('x', '2026-03-29', 1))).toEqual([]);
    const strict = employee('s', { limits: { ...e.limits, minDailyRestMinutes: 720 } });
    const c2 = ctx({ weekStart: '2026-03-23', employees: [strict], availableAll: ['s'] });
    const v = checkCandidate(c2, new AssignmentIndex([[asg('s', '2026-03-28', 4)]]), asg('s', '2026-03-29', 1));
    expect(v.map((x) => x.code)).toContain('REST_PERIOD');
    // the same pattern on an ordinary night gives 12 h and passes
    expect(checkCandidate(c2, new AssignmentIndex([[asg('s', '2026-03-24', 4)]]), asg('s', '2026-03-25', 1))).toEqual([]);
  });
  it('keeps every shift exactly 3 hours in a DST week', () => {
    const c = ctx({ weekStart: '2026-10-19', employees: [] });
    for (const d of week('2026-10-19')) {
      for (const s of [1, 2, 3, 4]) {
        const t = c.slotTimes(d, s);
        expect(t.endMs - t.startMs).toBe(3 * 3600000);
      }
    }
  });
});

describe('15. preferences versus staffing', () => {
  it('still staffs a shift with someone who would rather avoid it, but never with someone unavailable', () => {
    const c = ctx({
      employees: [employee('avoid', { shiftPreferences: { 4: -1 } }), employee('busy', { shiftPreferences: { 4: 1 } })],
      available: [['avoid', MON, 4]],
      unavailable: [['busy', MON, 4]],
      onlyDates: [MON],
      onlySlots: [4],
      minStaff: 1,
    });
    const r = generateSchedule(c, 'fill');
    expect(r.added.map((a) => a.userId)).toEqual(['avoid']);
  });
  it('prefers the employee who prefers the shift when both are valid', () => {
    const c = ctx({
      employees: [employee('a', { shiftPreferences: { 1: -1 } }), employee('b', { shiftPreferences: { 1: 1 } })],
      availableAll: ['a', 'b'],
      onlyDates: [MON],
      onlySlots: [1],
      minStaff: 1,
    });
    expect(generateSchedule(c, 'fill').added.map((a) => a.userId)).toEqual(['b']);
  });
});

describe('fairness', () => {
  it('prefers the employee with fewer recent hours', () => {
    const c = ctx({
      employees: [
        employee('busy', { history: { weeks: 4, workMinutes: 4 * 2400, weekendShifts: 0, lateShifts: 0 } }),
        employee('fresh', { history: { weeks: 4, workMinutes: 4 * 600, weekendShifts: 0, lateShifts: 0 } }),
      ],
      availableAll: ['busy', 'fresh'],
      onlyDates: [MON],
      onlySlots: [1],
      minStaff: 1,
    });
    expect(generateSchedule(c, 'fill').added.map((a) => a.userId)).toEqual(['fresh']);
  });
  it('spreads shifts instead of loading one person', () => {
    const emps = ids(4).map((id) => employee(id));
    const c = ctx({ employees: emps, availableAll: emps.map((e) => e.id), minStaff: 1 });
    const r = generateSchedule(c, 'fill');
    const counts = emps.map((e) => r.assignments.filter((a) => a.userId === e.id).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
  });
});

describe('weekly rest and weekly hours', () => {
  it('rejects a seventh consecutive working day', () => {
    const c = ctx({ employees: [employee('x')], availableAll: ['x'] });
    const six = week(MON).slice(0, 6).map((d) => asg('x', d, 1));
    expect(checkCandidate(c, new AssignmentIndex([six]), asg('x', '2026-11-29', 1)).map((v) => v.code)).toContain('CONSECUTIVE_DAYS');
  });
  it('rejects work beyond the weekly maximum', () => {
    const x = employee('x', { limits: { ...employee('x').limits, maxWeeklyWorkMinutes: 600 } });
    const c = ctx({ employees: [x], availableAll: ['x'] });
    const existing = [asg('x', MON, 1), asg('x', MON, 2), asg('x', TUE, 1)]; // 5.5 h + 3 h = 8.5 h
    expect(checkCandidate(c, new AssignmentIndex([existing]), asg('x', '2026-11-25', 1)).map((v) => v.code)).toContain('WEEKLY_LIMIT');
  });
});

describe('sickness', () => {
  it('makes an employee ineligible for the whole day', () => {
    const c = ctx({ employees: [employee('x')], availableAll: ['x'], sick: [`x:${MON}`] });
    expect(checkCandidate(c, new AssignmentIndex([]), asg('x', MON, 4)).map((v) => v.code)).toContain('SICK');
  });
});

describe('generator never violates a hard constraint (randomised)', () => {
  for (const seed of [1, 7, 42, 99, 2026]) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      const emps = ids(30).map((id, i) =>
        employee(id, {
          skills: [
            ...(i % 3 === 0 ? [{ skillId: CASHIER, validUntil: null }] : []),
            ...(i % 7 === 0 ? [{ skillId: BAKERY, validUntil: null }] : []),
          ],
          shiftPreferences: { 1: r() > 0.7 ? 1 : 0, 4: r() > 0.7 ? -1 : 0 },
          contractWeeklyMinutes: r() > 0.5 ? 1200 : null,
          history: { weeks: 4, workMinutes: Math.floor(r() * 9600), weekendShifts: Math.floor(r() * 6), lateShifts: Math.floor(r() * 8) },
        }),
      );
      const available: [string, string, number][] = [];
      const unavailable: [string, string, number][] = [];
      for (const e of emps) {
        if (r() < 0.15) continue; // never submitted
        for (const d of week(MON)) for (const s of [1, 2, 3, 4]) (r() < 0.6 ? available : unavailable).push([e.id, d, s]);
      }
      const c = ctx({
        employees: emps,
        available,
        unavailable,
        minStaff: 6,
        skillNeeds: [
          { skillId: CASHIER, minCount: 2 },
          { skillId: BAKERY, minCount: 1 },
        ],
        sick: [`e05:${TUE}`],
      });
      const res = generateSchedule(c, 'fill');
      const bad = res.issues.filter((i) => PER_EMPLOYEE_ERRORS.has(i.code));
      expect(bad).toEqual([]);
      // re-check every assignment independently against all others
      for (const a of res.assignments) {
        const others = res.assignments.filter((x) => x !== a);
        expect(checkCandidate(c, new AssignmentIndex([others]), a)).toEqual([]);
      }
    });
  }
});
