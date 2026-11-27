/** Pure data types for the scheduling engine. No database access happens in this folder. */

export interface ShiftTemplate {
  slot: number;
  start: string; // local HH:MM
  end: string;
}

export interface BreakRule {
  consecutiveShifts: number;
  breakMinutes: number;
  earliestStartOffsetMinutes: number;
  latestEndOffsetMinutes: number;
}

export interface Weights {
  preferredBranch: number;
  preferredTime: number;
  fairHours: number;
  fairWeekends: number;
  fairLate: number;
  targetHours: number;
  fragmentation: number;
  continuity: number;
}

export interface Policy {
  versionId: number;
  maxDailyWorkMinutes: number;
  maxWeeklyWorkMinutes: number;
  minDailyRestMinutes: number;
  maxConsecutiveWorkDays: number;
  breaksPaid: boolean;
  staffingCountsBreaks: boolean;
  singleBranchPerDay: boolean;
  breakGranularityMinutes: number;
  fairnessLookbackWeeks: number;
  weights: Weights;
  breakRules: BreakRule[];
}

export interface Limits {
  maxDailyWorkMinutes: number;
  maxWeeklyWorkMinutes: number;
  minDailyRestMinutes: number;
  maxConsecutiveWorkDays: number;
  latestEndTime: string | null;
}

export interface EmployeeSkill {
  skillId: string;
  validUntil: string | null;
}

export interface FairnessHistory {
  /** Weeks of history actually observed (0..lookback). */
  weeks: number;
  workMinutes: number;
  weekendShifts: number;
  lateShifts: number;
}

export interface EmployeeInfo {
  id: string;
  name: string;
  active: boolean;
  branchIds: string[];
  skills: EmployeeSkill[];
  preferredBranches: { branchId: string; rank: number }[];
  shiftPreferences: Record<number, number>; // slot -> -1 | 0 | 1
  contractWeeklyMinutes: number | null;
  limits: Limits;
  history: FairnessHistory;
  /** `${isoWeekday}:${slot}` worked in the previous week (continuity). */
  previousWeekPattern: Set<string>;
}

export type AvailabilityStatus = 'available' | 'unavailable';

export interface Assignment {
  id?: string;
  userId: string;
  branchId: string;
  date: string;
  slot: number;
  roleSkillId: string | null;
  source?: 'manual' | 'generated' | 'cover';
}

export interface SkillNeed {
  skillId: string;
  minCount: number;
}

export interface CellRequirement {
  date: string;
  slot: number;
  minStaff: number;
  skills: SkillNeed[];
}

export interface PlacedBreak {
  userId: string;
  branchId: string;
  date: string;
  startMs: number;
  endMs: number;
  minutes: number;
  blockStartSlot: number;
  blockEndSlot: number;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  date?: string;
  slot?: number;
  userId?: string;
  skillId?: string;
}

export interface Violation {
  code: string;
  message: string;
}

export interface EngineContext {
  branchId: string;
  /** Dates of the schedule period (one ISO week). */
  dates: string[];
  templates: ShiftTemplate[];
  policy: Policy;
  employees: Map<string, EmployeeInfo>;
  /** userId -> `${date}:${slot}` -> status. Missing key = not submitted. */
  availability: Map<string, Map<string, AvailabilityStatus>>;
  requirements: CellRequirement[];
  /** Active assignments in this branch's schedule (the working copy). */
  assignments: Assignment[];
  /** Active assignments of the same employees outside this schedule (other branches/weeks), ±14 days. */
  externalAssignments: Assignment[];
  /** `${userId}:${date}` with a sickness report. */
  sickDays: Set<string>;
  skillNames: Map<string, string>;
  /** UTC instants for a local shift. */
  slotTimes: (date: string, slot: number) => { startMs: number; endMs: number };
}

export interface ScoreBreakdown {
  total: number;
  factors: { key: keyof Weights | 'scarcity'; value: number; weighted: number }[];
}

export interface Candidate {
  userId: string;
  name: string;
  feasible: boolean;
  violations: Violation[];
  availability: AvailabilityStatus | 'not_submitted';
  weekWorkMinutes: number;
  score: ScoreBreakdown | null;
  reasons: string[];
  /** Valid, but would cause a schedule-level problem (e.g. break coverage). */
  warnings: string[];
}
