/**
 * Schedule generation.
 *
 * 1. Keep manual and cover assignments (and, in "fill" mode, earlier generated ones).
 * 2. Repeatedly pick the most urgent unmet need: the (shift, role) whose number of feasible
 *    candidates exceeds its remaining seats by the least. Role seats come before general seats.
 * 3. Fill it with the best-scoring feasible employee. Feasibility = every hard constraint
 *    (checkCandidate); the score only ranks employees who are already valid, so a soft
 *    preference can never override a hard constraint.
 * 4. Place breaks and add break-relief staff where breaks would take coverage below minimum.
 * 5. Validate the result and return every remaining problem with an explanation.
 */
import { isWeekend, isoWeekday, weekStartOf } from '../lib/time.js';
import { placeBreaksForDay } from './breaks.js';
import { AssignmentIndex, checkCandidate, groupByDate, hasValidSkill, weekWorkMinutes } from './rules.js';
import type { Assignment, Candidate, CellRequirement, EmployeeInfo, EngineContext, Issue, PlacedBreak, ScoreBreakdown, Violation } from './types.js';
import { requirementMap, validateSchedule } from './validate.js';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function scoreCandidate(
  ctx: EngineContext,
  index: AssignmentIndex,
  emp: EmployeeInfo,
  cand: Assignment,
  opts: { generalSeat: boolean; scarceSkills: Set<string> },
): ScoreBreakdown {
  const w = ctx.policy.weights;
  const mine = index.forUser(emp.id);
  const byDate = groupByDate(mine);
  const weekMin = weekWorkMinutes(ctx, byDate, weekStartOf(cand.date));
  const h = emp.history;
  const histWeekly = h.weeks > 0 ? h.workMinutes / h.weeks : 0;
  const lastSlot = Math.max(...ctx.templates.map((t) => t.slot));

  const fairHours = clamp((weekMin + 0.5 * histWeekly) / 2400, 0, 2);

  let targetHours = 0.5;
  if (emp.contractWeeklyMinutes && emp.contractWeeklyMinutes > 0) {
    const ratio = (weekMin + 180) / emp.contractWeeklyMinutes;
    targetHours = ratio <= 1 ? ratio * 0.5 : clamp(0.5 + (ratio - 1) * 2, 0, 3);
  }

  let preferredBranch = 0;
  if (emp.preferredBranches.length) {
    const p = emp.preferredBranches.find((b) => b.branchId === cand.branchId);
    preferredBranch = p ? (p.rank - 1) / 3 : 1;
  }

  const pref = emp.shiftPreferences[cand.slot] ?? 0;
  const preferredTime = pref === 1 ? 0 : pref === -1 ? 1 : 0.5;

  const weekInDates = mine.filter((a) => weekStartOf(a.date) === weekStartOf(cand.date));
  let fairWeekends = 0;
  if (isWeekend(cand.date)) {
    const thisWeek = weekInDates.filter((a) => isWeekend(a.date)).length;
    fairWeekends = clamp(((h.weeks ? h.weekendShifts / h.weeks : 0) + thisWeek) / 2, 0, 1);
  }
  let fairLate = 0;
  if (cand.slot === lastSlot) {
    const thisWeek = weekInDates.filter((a) => a.slot === lastSlot).length;
    fairLate = clamp(((h.weeks ? h.lateShifts / h.weeks : 0) + thisWeek) / 3, 0, 1);
  }

  const sameDay = byDate.get(cand.date) ?? [];
  let fragmentation = 0.25;
  if (sameDay.length) {
    const c = ctx.slotTimes(cand.date, cand.slot);
    const adjacent = sameDay.some((a) => {
      const t = ctx.slotTimes(a.date, a.slot);
      return t.endMs === c.startMs || t.startMs === c.endMs;
    });
    fragmentation = adjacent ? 0 : 1;
  }

  const continuity = emp.previousWeekPattern.size === 0 ? 0.5 : emp.previousWeekPattern.has(`${isoWeekday(cand.date)}:${cand.slot}`) ? 0 : 1;

  let scarcity = 0;
  if (opts.generalSeat && opts.scarceSkills.size) {
    scarcity = emp.skills.some((s) => opts.scarceSkills.has(s.skillId) && hasValidSkill(emp, s.skillId, cand.date)) ? 1 : 0;
  }

  const factors: ScoreBreakdown['factors'] = [
    { key: 'fairHours', value: fairHours, weighted: fairHours * w.fairHours },
    { key: 'targetHours', value: targetHours, weighted: targetHours * w.targetHours },
    { key: 'preferredBranch', value: preferredBranch, weighted: preferredBranch * w.preferredBranch },
    { key: 'preferredTime', value: preferredTime, weighted: preferredTime * w.preferredTime },
    { key: 'fairWeekends', value: fairWeekends, weighted: fairWeekends * w.fairWeekends },
    { key: 'fairLate', value: fairLate, weighted: fairLate * w.fairLate },
    { key: 'fragmentation', value: fragmentation, weighted: fragmentation * w.fragmentation },
    { key: 'continuity', value: continuity, weighted: continuity * w.continuity },
    { key: 'scarcity', value: scarcity, weighted: scarcity * 1.5 },
  ];
  return { total: Math.round(factors.reduce((s, f) => s + f.weighted, 0) * 1000) / 1000, factors };
}

function reasonsFor(ctx: EngineContext, index: AssignmentIndex, emp: EmployeeInfo, cand: Assignment): string[] {
  const r: string[] = ['Available and meets every hard rule'];
  const pref = emp.shiftPreferences[cand.slot] ?? 0;
  if (pref === 1) r.push('Prefers this shift time');
  if (pref === -1) r.push('Prefers to avoid this shift time');
  const pb = emp.preferredBranches.find((b) => b.branchId === cand.branchId);
  if (pb?.rank === 1) r.push('Prefers this branch');
  else if (emp.preferredBranches.length && !pb) r.push('Prefers another branch');
  const weekMin = weekWorkMinutes(ctx, groupByDate(index.forUser(emp.id)), weekStartOf(cand.date));
  r.push(`${Math.round((weekMin / 60) * 10) / 10} h scheduled this week`);
  if (emp.contractWeeklyMinutes) {
    r.push(weekMin < emp.contractWeeklyMinutes ? 'Below contract hours' : 'At or above contract hours');
  }
  return r;
}

/** Every employee of the branch for one shift, with hard-rule result, score and explanation. */
export function listCandidates(ctx: EngineContext, date: string, slot: number, roleSkillId: string | null): Candidate[] {
  const index = new AssignmentIndex([ctx.assignments, ctx.externalAssignments]);
  const scarce = new Set(ctx.requirements.flatMap((r) => r.skills.map((s) => s.skillId)));
  const out: Candidate[] = [];
  const reqBySlot = new Map(ctx.requirements.filter((r) => r.date === date).map((r) => [r.slot, r] as [number, CellRequirement]));
  const day = ctx.assignments.filter((a) => a.date === date);
  const gapsWith = (extra: Assignment[]) =>
    placeBreaksForDay(ctx, date, [...day, ...extra], reqBySlot).issues.filter((i) => i.code === 'BREAK_COVERAGE').length;
  const baseGaps = ctx.policy.staffingCountsBreaks ? gapsWith([]) : 0;
  for (const emp of ctx.employees.values()) {
    if (!emp.branchIds.includes(ctx.branchId)) continue;
    const cand: Assignment = { userId: emp.id, branchId: ctx.branchId, date, slot, roleSkillId };
    const violations: Violation[] = checkCandidate(ctx, index, cand);
    const av = ctx.availability.get(emp.id)?.get(`${date}:${slot}`) ?? 'not_submitted';
    const weekMin = weekWorkMinutes(ctx, groupByDate(index.forUser(emp.id)), weekStartOf(date));
    const feasible = violations.length === 0;
    const warnings: string[] = [];
    if (feasible && ctx.policy.staffingCountsBreaks) {
      const sameDay = day.some((a) => a.userId === emp.id);
      if (sameDay && gapsWith([cand]) > baseGaps) {
        warnings.push('Works an adjacent shift here; the extra break would leave the floor below minimum. Add break relief or choose someone else.');
      }
    }
    out.push({
      userId: emp.id,
      name: emp.name,
      feasible,
      violations,
      availability: av,
      weekWorkMinutes: weekMin,
      score: feasible ? scoreCandidate(ctx, index, emp, cand, { generalSeat: !roleSkillId, scarceSkills: scarce }) : null,
      reasons: feasible ? reasonsFor(ctx, index, emp, cand) : violations.map((v) => v.message),
      warnings,
    });
  }
  return out.sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    if (a.warnings.length !== b.warnings.length) return a.warnings.length - b.warnings.length;
    if (a.score && b.score && a.score.total !== b.score.total) return a.score.total - b.score.total;
    return a.name.localeCompare(b.name);
  });
}

interface Need {
  date: string;
  slot: number;
  skillId: string | null;
  remaining: number;
}

export interface GenerateResult {
  assignments: Assignment[];
  added: Assignment[];
  removed: Assignment[];
  issues: Issue[];
  breaks: PlacedBreak[];
}

export function generateSchedule(ctx: EngineContext, mode: 'fill' | 'replace'): GenerateResult {
  const removed = mode === 'replace' ? ctx.assignments.filter((a) => a.source === 'generated') : [];
  const working = ctx.assignments.filter((a) => !removed.includes(a));
  const added: Assignment[] = [];
  const index = new AssignmentIndex([working, ctx.externalAssignments]);
  const reqs = requirementMap(ctx.requirements);
  const scarce = new Set(ctx.requirements.flatMap((r) => r.skills.map((s) => s.skillId)));
  const eligible = [...ctx.employees.values()]
    .filter((e) => e.active && e.branchIds.includes(ctx.branchId))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // Feasibility cache, invalidated per employee whenever that employee's assignments change.
  const cache = new Map<string, Map<string, boolean>>();
  const feasible = (emp: EmployeeInfo, date: string, slot: number, role: string | null) => {
    let m = cache.get(emp.id);
    if (!m) cache.set(emp.id, (m = new Map()));
    const key = `${date}:${slot}:${role ?? ''}`;
    let ok = m.get(key);
    if (ok === undefined) {
      ok = checkCandidate(ctx, index, { userId: emp.id, branchId: ctx.branchId, date, slot, roleSkillId: role }).length === 0;
      m.set(key, ok);
    }
    return ok;
  };
  const assign = (a: Assignment) => {
    working.push(a);
    added.push(a);
    index.add(a);
    cache.delete(a.userId);
  };
  const cellAssignments = (date: string, slot: number) => working.filter((a) => a.date === date && a.slot === slot);

  const blocked = new Set<string>();
  const needKey = (n: { date: string; slot: number; skillId: string | null }) => `${n.date}:${n.slot}:${n.skillId ?? ''}`;

  const computeNeeds = (): Need[] => {
    const needs: Need[] = [];
    for (const r of ctx.requirements) {
      const here = cellAssignments(r.date, r.slot);
      // Role seats that cannot be filled are left to general staff, so headcount is still met.
      let skillRemaining = 0;
      for (const s of r.skills) {
        const rem = s.minCount - here.filter((a) => a.roleSkillId === s.skillId).length;
        if (rem > 0 && !blocked.has(needKey({ date: r.date, slot: r.slot, skillId: s.skillId }))) {
          needs.push({ date: r.date, slot: r.slot, skillId: s.skillId, remaining: rem });
          skillRemaining += rem;
        }
      }
      const general = r.minStaff - here.length - skillRemaining;
      if (general > 0) needs.push({ date: r.date, slot: r.slot, skillId: null, remaining: general });
    }
    return needs;
  };

  for (let guard = 0; guard < 5000; guard++) {
    const needs = computeNeeds().filter((n) => !blocked.has(needKey(n)));
    if (!needs.length) break;
    let pick: { need: Need; slack: number; supply: Set<string> } | null = null;
    for (const need of needs) {
      const here = new Set(cellAssignments(need.date, need.slot).map((a) => a.userId));
      const supply = new Set(eligible.filter((e) => !here.has(e.id) && feasible(e, need.date, need.slot, need.skillId)).map((e) => e.id));
      const slack = supply.size - need.remaining;
      const better =
        !pick ||
        slack < pick.slack ||
        (slack === pick.slack && (need.skillId ? 0 : 1) < (pick.need.skillId ? 0 : 1)) ||
        (slack === pick.slack && !!need.skillId === !!pick.need.skillId && `${need.date}:${need.slot}` < `${pick.need.date}:${pick.need.slot}`);
      if (better) pick = { need, slack, supply };
    }
    if (!pick) break;
    const { need, supply } = pick;
    if (supply.size === 0) {
      blocked.add(needKey(need));
      continue;
    }
    let best: { emp: EmployeeInfo; score: number } | null = null;
    for (const emp of eligible) {
      if (!supply.has(emp.id)) continue;
      const cand: Assignment = { userId: emp.id, branchId: ctx.branchId, date: need.date, slot: need.slot, roleSkillId: need.skillId };
      const s = scoreCandidate(ctx, index, emp, cand, { generalSeat: !need.skillId, scarceSkills: scarce }).total;
      if (!best || s < best.score) best = { emp, score: s };
    }
    assign({ userId: best!.emp.id, branchId: ctx.branchId, date: need.date, slot: need.slot, roleSkillId: need.skillId, source: 'generated' });
  }

  // Break relief: add staff where breaks would take coverage below the minimum.
  if (ctx.policy.staffingCountsBreaks) {
    for (const date of ctx.dates) {
      for (let round = 0; round < 6; round++) {
        const reqBySlot = new Map(
          ctx.templates.map((t) => [t.slot, reqs.get(`${date}:${t.slot}`)] as const).filter(([, r]) => r) as [number, CellRequirement][],
        );
        const { issues } = placeBreaksForDay(ctx, date, working.filter((a) => a.date === date), reqBySlot);
        const gaps = issues.filter((i) => i.code === 'BREAK_COVERAGE');
        if (!gaps.length) break;
        let progress = false;
        for (const g of gaps) {
          const here = new Set(cellAssignments(date, g.slot!).map((a) => a.userId));
          const role = g.skillId ?? null;
          const options = eligible
            .filter((e) => !here.has(e.id) && feasible(e, date, g.slot!, role))
            .map((e) => {
              const cand: Assignment = { userId: e.id, branchId: ctx.branchId, date, slot: g.slot!, roleSkillId: role };
              // Prefer people with no other shift that day: they need no break themselves.
              const busy = index.forUser(e.id).some((a) => a.date === date) ? 1 : 0;
              return { e, busy, s: scoreCandidate(ctx, index, e, cand, { generalSeat: !role, scarceSkills: scarce }).total };
            })
            .sort((a, b) => a.busy - b.busy || a.s - b.s);
          if (options.length) {
            assign({ userId: options[0].e.id, branchId: ctx.branchId, date, slot: g.slot!, roleSkillId: role, source: 'generated' });
            progress = true;
          }
        }
        if (!progress) break;
      }
    }
  }

  const result = validateSchedule({ ...ctx, assignments: working });
  return { assignments: working, added, removed, issues: result.issues, breaks: result.breaks };
}
