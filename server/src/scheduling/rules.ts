/**
 * Hard constraints for a single employee. Every function here is pure and deterministic.
 */
import { addDays, weekStartOf, minutesOfTime } from '../lib/time.js';
import type { Assignment, BreakRule, EmployeeInfo, EngineContext, Policy, Violation } from './types.js';

export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

export function fmtDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Break rule for a block of n consecutive shifts: the largest rule that is <= n. */
export function breakRuleFor(policy: Policy, n: number): BreakRule | null {
  if (n < 2) return null;
  let chosen: BreakRule | null = null;
  for (const r of [...policy.breakRules].sort((a, b) => a.consecutiveShifts - b.consecutiveShifts)) {
    if (r.consecutiveShifts <= n && r.breakMinutes > 0) chosen = r;
  }
  return chosen;
}

export interface Block {
  slots: number[];
  branchIds: string[];
  startMs: number;
  endMs: number;
  rule: BreakRule | null;
  breakMinutes: number;
}

export interface DayPlan {
  blocks: Block[];
  presenceMinutes: number;
  breakMinutes: number;
  workMinutes: number;
  firstStartMs: number;
  lastEndMs: number;
}

interface Timed {
  slot: number;
  branchId: string;
  startMs: number;
  endMs: number;
}

export function timed(ctx: EngineContext, items: Assignment[]): Timed[] {
  return items
    .map((a) => ({ slot: a.slot, branchId: a.branchId, ...ctx.slotTimes(a.date, a.slot) }))
    .sort((a, b) => a.startMs - b.startMs || a.slot - b.slot);
}

/** Groups a day's shifts into consecutive blocks and computes breaks and working time. */
export function dayPlan(ctx: EngineContext, items: Assignment[]): DayPlan {
  const t = timed(ctx, items);
  const blocks: Block[] = [];
  for (const s of t) {
    const last = blocks[blocks.length - 1];
    if (last && last.endMs === s.startMs) {
      last.slots.push(s.slot);
      last.branchIds.push(s.branchId);
      last.endMs = s.endMs;
    } else if (!last || s.startMs >= last.endMs) {
      blocks.push({ slots: [s.slot], branchIds: [s.branchId], startMs: s.startMs, endMs: s.endMs, rule: null, breakMinutes: 0 });
    } else {
      // Overlap: counted once in presence; reported separately as ALREADY_ASSIGNED.
      last.endMs = Math.max(last.endMs, s.endMs);
    }
  }
  let presence = 0;
  let breaks = 0;
  for (const b of blocks) {
    b.rule = breakRuleFor(ctx.policy, b.slots.length);
    b.breakMinutes = b.rule?.breakMinutes ?? 0;
    presence += (b.endMs - b.startMs) / 60000;
    breaks += b.breakMinutes;
  }
  return {
    blocks,
    presenceMinutes: presence,
    breakMinutes: breaks,
    workMinutes: presence - (ctx.policy.breaksPaid ? 0 : breaks),
    firstStartMs: t[0]?.startMs ?? 0,
    lastEndMs: t.length ? Math.max(...t.map((x) => x.endMs)) : 0,
  };
}

export function hasValidSkill(emp: EmployeeInfo, skillId: string, date: string): boolean {
  return emp.skills.some((s) => s.skillId === skillId && (!s.validUntil || s.validUntil >= date));
}

export function availabilityOf(ctx: EngineContext, userId: string, date: string, slot: number) {
  return ctx.availability.get(userId)?.get(`${date}:${slot}`);
}

/** Checks that concern a single assignment in isolation. */
export function assignmentViolations(ctx: EngineContext, emp: EmployeeInfo, a: Assignment, opts: { checkAvailability: boolean }): Violation[] {
  const v: Violation[] = [];
  if (!emp.active) v.push({ code: 'ACCOUNT_INACTIVE', message: 'Account is not active.' });
  if (!emp.branchIds.includes(a.branchId))
    v.push({ code: 'NOT_ELIGIBLE_BRANCH', message: 'Not eligible to work at this branch.' });
  if (ctx.sickDays.has(`${a.userId}:${a.date}`))
    v.push({ code: 'SICK', message: `Reported sick on ${fmtDate(a.date)}.` });
  if (opts.checkAvailability) {
    const av = availabilityOf(ctx, a.userId, a.date, a.slot);
    if (av === undefined)
      v.push({ code: 'AVAILABILITY_UNKNOWN', message: 'Has not submitted availability for this shift.' });
    else if (av === 'unavailable') v.push({ code: 'UNAVAILABLE', message: 'Marked unavailable for this shift.' });
  }
  if (a.roleSkillId && !hasValidSkill(emp, a.roleSkillId, a.date)) {
    const name = ctx.skillNames.get(a.roleSkillId) ?? 'the required';
    v.push({ code: 'SKILL_MISSING', message: `Does not hold a valid ${name} skill.` });
  }
  const tpl = ctx.templates.find((t) => t.slot === a.slot);
  if (emp.limits.latestEndTime && tpl && minutesOfTime(tpl.end) > minutesOfTime(emp.limits.latestEndTime)) {
    v.push({
      code: 'LATEST_END',
      message: `Shift ends after ${emp.limits.latestEndTime}, the latest end time in this employee's working-time profile.`,
    });
  }
  return v;
}

/** Overlap, branch-per-day and daily working-time checks for one date. */
export function dayViolations(ctx: EngineContext, emp: EmployeeInfo, items: Assignment[], date: string): Violation[] {
  if (!items.length) return [];
  const v: Violation[] = [];
  const t = timed(ctx, items);
  for (let i = 1; i < t.length; i++) {
    if (t[i].startMs < t[i - 1].endMs) {
      v.push({ code: 'ALREADY_ASSIGNED', message: `Already assigned to an overlapping shift on ${fmtDate(date)}.` });
      break;
    }
  }
  const branches = new Set(t.map((x) => x.branchId));
  if (ctx.policy.singleBranchPerDay && branches.size > 1) {
    v.push({ code: 'OTHER_BRANCH_SAME_DAY', message: `Already works at another branch on ${fmtDate(date)}.` });
  } else {
    for (let i = 1; i < t.length; i++) {
      if (t[i].startMs === t[i - 1].endMs && t[i].branchId !== t[i - 1].branchId) {
        v.push({
          code: 'CONSECUTIVE_OTHER_BRANCH',
          message: 'Consecutive shifts at different branches leave no travel time.',
        });
        break;
      }
    }
  }
  const plan = dayPlan(ctx, items);
  if (plan.workMinutes > emp.limits.maxDailyWorkMinutes) {
    v.push({
      code: 'DAILY_LIMIT',
      message: `${fmtMinutes(plan.workMinutes)} of work on ${fmtDate(date)} exceeds the ${fmtMinutes(emp.limits.maxDailyWorkMinutes)} daily limit.`,
    });
  }
  return v;
}

export function groupByDate(list: Assignment[]): Map<string, Assignment[]> {
  const m = new Map<string, Assignment[]>();
  for (const a of list) {
    const arr = m.get(a.date);
    if (arr) arr.push(a);
    else m.set(a.date, [a]);
  }
  return m;
}

export function weekWorkMinutes(ctx: EngineContext, byDate: Map<string, Assignment[]>, weekStart: string): number {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const items = byDate.get(addDays(weekStart, i));
    if (items?.length) total += dayPlan(ctx, items).workMinutes;
  }
  return total;
}

export function weekViolations(ctx: EngineContext, emp: EmployeeInfo, byDate: Map<string, Assignment[]>, weekStart: string): Violation[] {
  const total = weekWorkMinutes(ctx, byDate, weekStart);
  if (total > emp.limits.maxWeeklyWorkMinutes) {
    return [
      {
        code: 'WEEKLY_LIMIT',
        message: `${fmtMinutes(total)} of work in the week of ${fmtDate(weekStart)} exceeds the ${fmtMinutes(emp.limits.maxWeeklyWorkMinutes)} weekly limit.`,
      },
    ];
  }
  return [];
}

/** Daily rest between the end of work on d1 and the start of work on the next day. Uses real instants (DST-safe). */
export function restViolations(ctx: EngineContext, emp: EmployeeInfo, byDate: Map<string, Assignment[]>, d1: string): Violation[] {
  const a = byDate.get(d1);
  const b = byDate.get(addDays(d1, 1));
  if (!a?.length || !b?.length) return [];
  const end = Math.max(...timed(ctx, a).map((x) => x.endMs));
  const start = Math.min(...timed(ctx, b).map((x) => x.startMs));
  const rest = (start - end) / 60000;
  if (rest < emp.limits.minDailyRestMinutes) {
    return [
      {
        code: 'REST_PERIOD',
        message: `Only ${fmtMinutes(rest)} rest between ${fmtDate(d1)} and the next day; at least ${fmtMinutes(emp.limits.minDailyRestMinutes)} is required.`,
      },
    ];
  }
  return [];
}

export function consecutiveDaysViolations(emp: EmployeeInfo, byDate: Map<string, Assignment[]>, date: string): Violation[] {
  if (!byDate.get(date)?.length) return [];
  let run = 1;
  for (let d = addDays(date, -1); byDate.get(d)?.length; d = addDays(d, -1)) run++;
  for (let d = addDays(date, 1); byDate.get(d)?.length; d = addDays(d, 1)) run++;
  if (run > emp.limits.maxConsecutiveWorkDays) {
    return [
      {
        code: 'CONSECUTIVE_DAYS',
        message: `${run} working days in a row; the maximum is ${emp.limits.maxConsecutiveWorkDays} (weekly rest).`,
      },
    ];
  }
  return [];
}

/** All plan-level checks around one date. */
export function planViolationsAround(ctx: EngineContext, emp: EmployeeInfo, list: Assignment[], date: string): Violation[] {
  const byDate = groupByDate(list);
  return dedupe([
    ...dayViolations(ctx, emp, byDate.get(date) ?? [], date),
    ...weekViolations(ctx, emp, byDate, weekStartOf(date)),
    ...restViolations(ctx, emp, byDate, addDays(date, -1)),
    ...restViolations(ctx, emp, byDate, date),
    ...consecutiveDaysViolations(emp, byDate, date),
  ]);
}

export function dedupe(v: Violation[]): Violation[] {
  const seen = new Set<string>();
  return v.filter((x) => {
    const k = `${x.code}|${x.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Mutable index of every active assignment the engine knows about, per employee. */
export class AssignmentIndex {
  private byUser = new Map<string, Assignment[]>();

  constructor(lists: Assignment[][]) {
    for (const list of lists) for (const a of list) this.add(a);
  }

  add(a: Assignment) {
    const arr = this.byUser.get(a.userId);
    if (arr) arr.push(a);
    else this.byUser.set(a.userId, [a]);
  }

  remove(a: Assignment) {
    const arr = this.byUser.get(a.userId);
    if (!arr) return;
    const i = arr.indexOf(a);
    if (i >= 0) arr.splice(i, 1);
  }

  forUser(userId: string): Assignment[] {
    return this.byUser.get(userId) ?? [];
  }
}

/**
 * Every hard constraint for adding one assignment. An empty result means the assignment
 * may be saved. Cheap checks run first.
 */
export function checkCandidate(ctx: EngineContext, index: AssignmentIndex, cand: Assignment): Violation[] {
  const emp = ctx.employees.get(cand.userId);
  if (!emp) return [{ code: 'NOT_ELIGIBLE_BRANCH', message: 'Not eligible to work at this branch.' }];
  const v = assignmentViolations(ctx, emp, cand, { checkAvailability: true });
  const existing = index.forUser(cand.userId);
  if (existing.some((a) => a.date === cand.date && a.slot === cand.slot)) {
    v.push({ code: 'ALREADY_ASSIGNED', message: 'Already assigned to this shift.' });
    return dedupe(v);
  }
  v.push(...planViolationsAround(ctx, emp, [...existing, cand], cand.date));
  return dedupe(v);
}
