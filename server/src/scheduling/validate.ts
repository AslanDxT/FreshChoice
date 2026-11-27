/**
 * Schedule validation: produces the report shown before publishing. Errors block publication.
 */
import { placeBreaksForDay } from './breaks.js';
import {
  AssignmentIndex,
  assignmentViolations,
  checkCandidate,
  fmtDate,
  planViolationsAround,
} from './rules.js';
import type { Assignment, CellRequirement, EngineContext, Issue, PlacedBreak } from './types.js';

export interface CellCoverage {
  date: string;
  slot: number;
  assigned: number;
  minStaff: number;
  skills: { skillId: string; have: number; need: number }[];
  ok: boolean;
}

const REASON_LABEL: Record<string, string> = {
  AVAILABILITY_UNKNOWN: 'have not submitted availability',
  UNAVAILABLE: 'are unavailable',
  SICK: 'are reported sick',
  ALREADY_ASSIGNED: 'are already working at this time',
  OTHER_BRANCH_SAME_DAY: 'work at another branch that day',
  CONSECUTIVE_OTHER_BRANCH: 'work an adjacent shift at another branch',
  DAILY_LIMIT: 'would exceed the daily hour limit',
  WEEKLY_LIMIT: 'would exceed the weekly hour limit',
  REST_PERIOD: 'would not get enough rest',
  CONSECUTIVE_DAYS: 'would work too many days in a row',
  SKILL_MISSING: 'lack the skill',
  ACCOUNT_INACTIVE: 'have an inactive account',
  LATEST_END: 'cannot work this late (working-time profile)',
  NOT_ELIGIBLE_BRANCH: 'are not eligible for this branch',
};

export function shiftLabel(ctx: EngineContext, date: string, slot: number): string {
  const t = ctx.templates.find((x) => x.slot === slot);
  return `${fmtDate(date)} ${t?.start ?? ''}–${t?.end ?? ''}`;
}

/** Explains why the remaining employees cannot fill a shift. */
export function explainShortage(
  ctx: EngineContext,
  index: AssignmentIndex,
  date: string,
  slot: number,
  roleSkillId: string | null,
  assignedHere: Set<string>,
): { feasible: number; text: string } {
  const tally = new Map<string, number>();
  let feasible = 0;
  for (const emp of ctx.employees.values()) {
    if (!emp.branchIds.includes(ctx.branchId) || assignedHere.has(emp.id)) continue;
    const v = checkCandidate(ctx, index, { userId: emp.id, branchId: ctx.branchId, date, slot, roleSkillId });
    if (!v.length) {
      feasible++;
      continue;
    }
    const code = v[0].code;
    tally.set(code, (tally.get(code) ?? 0) + 1);
  }
  const parts = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${n} ${REASON_LABEL[code] ?? code.toLowerCase()}`);
  let text = parts.length ? `Of the other employees: ${parts.join(', ')}.` : 'There are no other eligible employees.';
  if (feasible) text += ` ${feasible} eligible employee${feasible === 1 ? ' is' : 's are'} still available to add.`;
  return { feasible, text };
}

export function requirementMap(reqs: CellRequirement[]): Map<string, CellRequirement> {
  return new Map(reqs.map((r) => [`${r.date}:${r.slot}`, r]));
}

export function validateSchedule(ctx: EngineContext): { issues: Issue[]; breaks: PlacedBreak[]; coverage: CellCoverage[] } {
  const issues: Issue[] = [];
  const breaks: PlacedBreak[] = [];
  const coverage: CellCoverage[] = [];
  const index = new AssignmentIndex([ctx.assignments, ctx.externalAssignments]);
  const reqs = requirementMap(ctx.requirements);

  // 1. Staffing and role coverage per shift.
  for (const date of ctx.dates) {
    for (const tpl of ctx.templates) {
      const req = reqs.get(`${date}:${tpl.slot}`);
      const here = ctx.assignments.filter((a) => a.date === date && a.slot === tpl.slot);
      const ids = new Set(here.map((a) => a.userId));
      const minStaff = req?.minStaff ?? 0;
      const cell: CellCoverage = { date, slot: tpl.slot, assigned: here.length, minStaff, skills: [], ok: true };
      if (here.length < minStaff) {
        cell.ok = false;
        const why = explainShortage(ctx, index, date, tpl.slot, null, ids);
        issues.push({
          severity: 'error',
          code: 'UNDERSTAFFED',
          message: `${shiftLabel(ctx, date, tpl.slot)}: ${here.length} of ${minStaff} staff. ${why.text}`,
          date,
          slot: tpl.slot,
        });
      }
      for (const need of req?.skills ?? []) {
        const have = here.filter((a) => a.roleSkillId === need.skillId).length;
        cell.skills.push({ skillId: need.skillId, have, need: need.minCount });
        if (have < need.minCount) {
          cell.ok = false;
          const name = ctx.skillNames.get(need.skillId) ?? 'skill';
          const why = explainShortage(ctx, index, date, tpl.slot, need.skillId, ids);
          issues.push({
            severity: 'error',
            code: 'SKILL_SHORTAGE',
            message: `${shiftLabel(ctx, date, tpl.slot)}: ${have} of ${need.minCount} ${name} staff. ${why.text}`,
            date,
            slot: tpl.slot,
            skillId: need.skillId,
          });
        }
      }
      coverage.push(cell);
    }
  }

  // 2. Per-assignment and per-employee hard constraints (can appear after availability or policy changes).
  const byUser = new Map<string, Assignment[]>();
  for (const a of ctx.assignments) {
    const arr = byUser.get(a.userId) ?? [];
    arr.push(a);
    byUser.set(a.userId, arr);
  }
  for (const [userId, mine] of byUser) {
    const emp = ctx.employees.get(userId);
    if (!emp) {
      issues.push({ severity: 'error', code: 'NOT_ELIGIBLE_BRANCH', message: 'An assigned employee is no longer eligible for this branch.', userId });
      continue;
    }
    for (const a of mine) {
      for (const v of assignmentViolations(ctx, emp, a, { checkAvailability: true })) {
        const code = v.code === 'AVAILABILITY_UNKNOWN' ? 'ASSIGNED_WITHOUT_AVAILABILITY' : v.code === 'UNAVAILABLE' ? 'ASSIGNED_UNAVAILABLE' : v.code;
        issues.push({
          severity: 'error',
          code,
          message: `${emp.name}, ${shiftLabel(ctx, a.date, a.slot)}: ${v.message}`,
          date: a.date,
          slot: a.slot,
          userId,
        });
      }
    }
    const all = index.forUser(userId);
    for (const date of [...new Set(mine.map((a) => a.date))].sort()) {
      for (const v of planViolationsAround(ctx, emp, all, date)) {
        if (issues.some((i) => i.userId === userId && i.code === v.code && i.message.endsWith(v.message))) continue;
        issues.push({ severity: 'error', code: v.code, message: `${emp.name}: ${v.message}`, date, userId });
      }
    }
  }

  // 3. Breaks (placement + coverage during breaks).
  for (const date of ctx.dates) {
    const day = ctx.assignments.filter((a) => a.date === date);
    const reqBySlot = new Map(ctx.templates.map((t) => [t.slot, reqs.get(`${date}:${t.slot}`)!]).filter(([, r]) => r) as [number, CellRequirement][]);
    const r = placeBreaksForDay(ctx, date, day, reqBySlot);
    breaks.push(...r.breaks);
    issues.push(...r.issues);
    for (const i of r.issues) {
      if (i.severity === 'error') {
        const c = coverage.find((x) => x.date === date && x.slot === i.slot);
        if (c) c.ok = false;
      }
    }
  }

  // 4. Information for the manager.
  const eligible = [...ctx.employees.values()].filter((e) => e.active && e.branchIds.includes(ctx.branchId));
  const notSubmitted = eligible.filter((e) => {
    const av = ctx.availability.get(e.id);
    return !ctx.dates.some((d) => ctx.templates.some((t) => av?.has(`${d}:${t.slot}`)));
  });
  if (notSubmitted.length) {
    issues.push({
      severity: 'info',
      code: 'NO_AVAILABILITY_SUBMITTED',
      message: `${notSubmitted.length} employee${notSubmitted.length === 1 ? ' has' : 's have'} not submitted availability for this week. They are never scheduled automatically.`,
    });
  }
  const unused = eligible.filter((e) => {
    const av = ctx.availability.get(e.id);
    const anyAvailable = ctx.dates.some((d) => ctx.templates.some((t) => av?.get(`${d}:${t.slot}`) === 'available'));
    return anyAvailable && !byUser.has(e.id);
  });
  if (unused.length) {
    issues.push({
      severity: 'info',
      code: 'UNUSED_AVAILABILITY',
      message: `${unused.length} employee${unused.length === 1 ? ' is' : 's are'} available this week but not scheduled.`,
    });
  }

  return { issues, breaks, coverage };
}
