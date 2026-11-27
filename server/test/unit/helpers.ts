/**
 * Synthetic fixtures for engine unit tests. These exist only in memory during tests and are
 * never written to any database.
 */
import { addDays, localToUtcMs } from '../../src/lib/time.js';
import type {
  Assignment,
  AvailabilityStatus,
  CellRequirement,
  EmployeeInfo,
  EngineContext,
  Policy,
  ShiftTemplate,
} from '../../src/scheduling/types.js';

export const BRANCH = 'branch-a';
export const OTHER_BRANCH = 'branch-b';
export const CASHIER = 'skill-cashier';
export const BAKERY = 'skill-bakery';

export const TEMPLATES: ShiftTemplate[] = [
  { slot: 1, start: '09:00', end: '12:00' },
  { slot: 2, start: '12:00', end: '15:00' },
  { slot: 3, start: '15:00', end: '18:00' },
  { slot: 4, start: '18:00', end: '21:00' },
];

export function policy(over: Partial<Policy> = {}): Policy {
  return {
    versionId: 1,
    maxDailyWorkMinutes: 540,
    maxWeeklyWorkMinutes: 3600,
    minDailyRestMinutes: 660,
    maxConsecutiveWorkDays: 6,
    breaksPaid: false,
    staffingCountsBreaks: true,
    singleBranchPerDay: true,
    breakGranularityMinutes: 15,
    fairnessLookbackWeeks: 8,
    weights: {
      preferredBranch: 3,
      preferredTime: 3,
      fairHours: 5,
      fairWeekends: 3,
      fairLate: 2,
      targetHours: 4,
      fragmentation: 2,
      continuity: 1,
    },
    breakRules: [
      { consecutiveShifts: 2, breakMinutes: 30, earliestStartOffsetMinutes: 120, latestEndOffsetMinutes: 60 },
      { consecutiveShifts: 3, breakMinutes: 60, earliestStartOffsetMinutes: 120, latestEndOffsetMinutes: 60 },
    ],
    ...over,
  };
}

export function employee(id: string, over: Partial<EmployeeInfo> = {}): EmployeeInfo {
  return {
    id,
    name: `Test ${id}`,
    active: true,
    branchIds: [BRANCH],
    skills: [],
    preferredBranches: [],
    shiftPreferences: {},
    contractWeeklyMinutes: null,
    limits: { maxDailyWorkMinutes: 540, maxWeeklyWorkMinutes: 3600, minDailyRestMinutes: 660, maxConsecutiveWorkDays: 6, latestEndTime: null },
    history: { weeks: 0, workMinutes: 0, weekendShifts: 0, lateShifts: 0 },
    previousWeekPattern: new Set(),
    ...over,
  };
}

export function week(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export interface CtxInput {
  weekStart?: string;
  employees: EmployeeInfo[];
  available?: [string, string, number][]; // userId, date, slot
  unavailable?: [string, string, number][];
  availableAll?: string[]; // userIds available for every shift of the week
  requirements?: CellRequirement[];
  minStaff?: number;
  skillNeeds?: { skillId: string; minCount: number }[];
  assignments?: Assignment[];
  external?: Assignment[];
  sick?: string[];
  policy?: Policy;
  onlyDates?: string[];
  onlySlots?: number[];
}

export function ctx(input: CtxInput): EngineContext {
  const dates = week(input.weekStart ?? '2026-11-23');
  const availability = new Map<string, Map<string, AvailabilityStatus>>();
  const set = (u: string, d: string, s: number, st: AvailabilityStatus) => {
    if (!availability.has(u)) availability.set(u, new Map());
    availability.get(u)!.set(`${d}:${s}`, st);
  };
  for (const u of input.availableAll ?? []) for (const d of dates) for (const t of TEMPLATES) set(u, d, t.slot, 'available');
  for (const [u, d, s] of input.available ?? []) set(u, d, s, 'available');
  for (const [u, d, s] of input.unavailable ?? []) set(u, d, s, 'unavailable');
  const reqDates = input.onlyDates ?? dates;
  const reqSlots = input.onlySlots ?? TEMPLATES.map((t) => t.slot);
  const requirements =
    input.requirements ??
    reqDates.flatMap((d) => reqSlots.map((s) => ({ date: d, slot: s, minStaff: input.minStaff ?? 0, skills: input.skillNeeds ?? [] })));
  const cache = new Map<string, { startMs: number; endMs: number }>();
  return {
    branchId: BRANCH,
    dates,
    templates: TEMPLATES,
    policy: input.policy ?? policy(),
    employees: new Map(input.employees.map((e) => [e.id, e])),
    availability,
    requirements,
    assignments: input.assignments ?? [],
    externalAssignments: input.external ?? [],
    sickDays: new Set(input.sick ?? []),
    skillNames: new Map([
      [CASHIER, 'Cashier'],
      [BAKERY, 'Bakery'],
    ]),
    slotTimes: (date, slot) => {
      const k = `${date}:${slot}`;
      let v = cache.get(k);
      if (!v) {
        const t = TEMPLATES.find((x) => x.slot === slot)!;
        v = { startMs: localToUtcMs(date, t.start), endMs: localToUtcMs(date, t.end) };
        cache.set(k, v);
      }
      return v;
    },
  };
}

export function asg(userId: string, date: string, slot: number, roleSkillId: string | null = null, branchId = BRANCH): Assignment {
  return { userId, branchId, date, slot, roleSkillId, source: 'manual' };
}

/** Small deterministic PRNG (mulberry32) for repeatable randomised tests. */
export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
