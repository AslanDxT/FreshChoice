/**
 * Break placement.
 *
 * Shifts are back to back, so a break is a slice of time *inside* an employee's consecutive
 * block. Breaks are placed on a grid (default 15 minutes) inside a window from the break rule,
 * and staggered so that the number of people on the floor, and people working in each required
 * role, stays at or above the shift's minimum wherever possible.
 *
 * Breaks never move shift times. When staggering cannot keep coverage, the shortfall is reported
 * as BREAK_COVERAGE so a manager (or the generator) can add break relief.
 */
import { localTimeOf } from '../lib/time.js';
import { dayPlan, fmtDate } from './rules.js';
import type { Assignment, CellRequirement, EngineContext, Issue, PlacedBreak } from './types.js';

interface Taker {
  userId: string;
  blockStartSlot: number;
  blockEndSlot: number;
  minutes: number;
  windowStart: number; // ms, earliest break start
  windowEnd: number; // ms, latest break start
  preferredMid: number; // ms
  rolesBySlot: Map<number, string | null>;
}

export function placeBreaksForDay(
  ctx: EngineContext,
  date: string,
  dayAssignments: Assignment[],
  reqBySlot: Map<number, CellRequirement>,
): { breaks: PlacedBreak[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const breaks: PlacedBreak[] = [];
  if (!dayAssignments.length) return { breaks, issues };

  const step = ctx.policy.breakGranularityMinutes * 60000;
  const slotTimes = ctx.templates.map((t) => ({ slot: t.slot, ...ctx.slotTimes(date, t.slot) }));
  const t0 = Math.min(...slotTimes.map((s) => s.startMs));
  const tEnd = Math.max(...slotTimes.map((s) => s.endMs));
  const n = Math.round((tEnd - t0) / step);
  const slotAt = (i: number) => slotTimes.find((s) => t0 + i * step >= s.startMs && t0 + i * step < s.endMs)?.slot ?? 0;

  const stepSlot: number[] = [];
  const onFloor: number[] = new Array(n).fill(0);
  const assigned: number[] = new Array(n).fill(0);
  const breaksAt: number[] = new Array(n).fill(0);
  const roleCount: Map<string, number>[] = Array.from({ length: n }, () => new Map());
  for (let i = 0; i < n; i++) stepSlot.push(slotAt(i));

  const byUser = new Map<string, Assignment[]>();
  for (const a of dayAssignments) {
    const arr = byUser.get(a.userId) ?? [];
    arr.push(a);
    byUser.set(a.userId, arr);
    for (let i = 0; i < n; i++) {
      if (stepSlot[i] === a.slot) {
        onFloor[i]++;
        assigned[i]++;
        if (a.roleSkillId) roleCount[i].set(a.roleSkillId, (roleCount[i].get(a.roleSkillId) ?? 0) + 1);
      }
    }
  }

  const takers: Taker[] = [];
  for (const [userId, items] of [...byUser.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const plan = dayPlan(ctx, items);
    for (const block of plan.blocks) {
      if (!block.rule || block.breakMinutes <= 0) continue;
      const len = block.breakMinutes * 60000;
      let ws = block.startMs + block.rule.earliestStartOffsetMinutes * 60000;
      let we = block.endMs - block.rule.latestEndOffsetMinutes * 60000 - len;
      if (we < ws) {
        issues.push({
          severity: 'warning',
          code: 'BREAK_WINDOW',
          message: `The break window for ${block.slots.length} consecutive shifts is too narrow; the break was placed anywhere inside the block.`,
          date,
          userId,
        });
        ws = block.startMs;
        we = block.endMs - len;
      }
      // Prefer the shift boundary nearest the middle of the block.
      const mid = (block.startMs + block.endMs) / 2;
      const boundaries = block.slots.slice(1).map((s) => ctx.slotTimes(date, s).startMs);
      const preferredMid = boundaries.reduce((best, b) => (Math.abs(b - mid) < Math.abs(best - mid) ? b : best), mid);
      const rolesBySlot = new Map<number, string | null>();
      for (const a of items) rolesBySlot.set(a.slot, a.roleSkillId);
      takers.push({
        userId,
        blockStartSlot: block.slots[0],
        blockEndSlot: block.slots[block.slots.length - 1],
        minutes: block.breakMinutes,
        windowStart: ws,
        windowEnd: we,
        preferredMid,
        rolesBySlot,
      });
    }
  }

  // Least flexible first, then by id for determinism.
  takers.sort((a, b) => a.windowEnd - a.windowStart - (b.windowEnd - b.windowStart) || (a.userId < b.userId ? -1 : 1));

  const reqAt = (i: number) => reqBySlot.get(stepSlot[i]);
  const counts = ctx.policy.staffingCountsBreaks;

  for (const tk of takers) {
    const len = Math.round((tk.minutes * 60000) / step);
    let best: { s: number; cost: number; conc: number; dist: number } | null = null;
    const first = Math.ceil((tk.windowStart - t0) / step);
    const last = Math.floor((tk.windowEnd - t0) / step);
    for (let s = first; s <= last; s++) {
      if (s < 0 || s + len > n) continue;
      let cost = 0;
      let conc = 0;
      for (let k = s; k < s + len; k++) {
        const req = reqAt(k);
        if (counts && req) {
          cost += Math.max(0, req.minStaff - (onFloor[k] - 1)) - Math.max(0, req.minStaff - onFloor[k]);
          const role = tk.rolesBySlot.get(stepSlot[k]);
          const need = role ? req.skills.find((x) => x.skillId === role) : undefined;
          if (role && need) {
            const c = roleCount[k].get(role) ?? 0;
            cost += Math.max(0, need.minCount - (c - 1)) - Math.max(0, need.minCount - c);
          }
        }
        conc = Math.max(conc, breaksAt[k] + 1);
      }
      const dist = Math.abs(t0 + s * step + (len * step) / 2 - tk.preferredMid);
      if (!best || cost < best.cost || (cost === best.cost && (conc < best.conc || (conc === best.conc && dist < best.dist)))) {
        best = { s, cost, conc, dist };
      }
    }
    if (!best) continue;
    for (let k = best.s; k < best.s + len; k++) {
      onFloor[k]--;
      breaksAt[k]++;
      const role = tk.rolesBySlot.get(stepSlot[k]);
      if (role) roleCount[k].set(role, (roleCount[k].get(role) ?? 0) - 1);
    }
    const startMs = t0 + best.s * step;
    breaks.push({
      userId: tk.userId,
      branchId: ctx.branchId,
      date,
      startMs,
      endMs: startMs + tk.minutes * 60000,
      minutes: tk.minutes,
      blockStartSlot: tk.blockStartSlot,
      blockEndSlot: tk.blockEndSlot,
    });
  }

  if (counts) {
    // Report stretches where breaks (not missing assignments) take coverage below the minimum.
    type Gap = { slot: number; from: number; to: number; worst: number; need: number; skillId?: string };
    const gaps: Gap[] = [];
    const pushGap = (slot: number, i: number, have: number, need: number, skillId?: string) => {
      const g = gaps.find((x) => x.slot === slot && x.skillId === skillId && x.to === i);
      if (g) {
        g.to = i + 1;
        g.worst = Math.min(g.worst, have);
      } else gaps.push({ slot, from: i, to: i + 1, worst: have, need, skillId });
    };
    for (let i = 0; i < n; i++) {
      const req = reqAt(i);
      if (!req || breaksAt[i] === 0) continue;
      if (assigned[i] >= req.minStaff && onFloor[i] < req.minStaff) pushGap(stepSlot[i], i, onFloor[i], req.minStaff);
      for (const need of req.skills) {
        const assignedRole = dayAssignments.filter((a) => a.slot === stepSlot[i] && a.roleSkillId === need.skillId).length;
        const c = roleCount[i].get(need.skillId) ?? 0;
        if (assignedRole >= need.minCount && c < need.minCount) pushGap(stepSlot[i], i, c, need.minCount, need.skillId);
      }
    }
    for (const g of gaps) {
      const from = localTimeOf(t0 + g.from * step);
      const to = localTimeOf(t0 + g.to * step);
      const what = g.skillId ? `${ctx.skillNames.get(g.skillId) ?? 'role'} staff` : 'staff';
      issues.push({
        severity: 'error',
        code: 'BREAK_COVERAGE',
        message: `${fmtDate(date)} ${from}–${to}: only ${g.worst} of ${g.need} ${what} on the floor because of breaks. Add break relief or relax the policy.`,
        date,
        slot: g.slot,
        skillId: g.skillId,
      });
    }
  }

  return { breaks, issues };
}
