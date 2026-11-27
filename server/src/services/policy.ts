import type { Db } from '../db/pool.js';
import { many, one } from '../db/pool.js';
import type { Policy } from '../scheduling/types.js';

export interface PolicyView {
  id: number;
  versionNo: number;
  maxDailyWorkMinutes: number;
  maxWeeklyWorkMinutes: number;
  minDailyRestMinutes: number;
  maxConsecutiveWorkDays: number;
  breaksPaid: boolean;
  staffingCountsBreaks: boolean;
  singleBranchPerDay: boolean;
  breakGranularityMinutes: number;
  fairnessLookbackWeeks: number;
  weights: Policy['weights'];
  breakRules: Policy['breakRules'];
  note: string | null;
  createdAt: string;
}

export async function policyRow(client: Db, id?: number): Promise<PolicyView> {
  const r = id
    ? await one(client, 'SELECT * FROM scheduling_policy_versions WHERE id = $1', [id])
    : await one(client, 'SELECT * FROM scheduling_policy_versions ORDER BY version_no DESC LIMIT 1');
  const rules = await many(client, 'SELECT * FROM break_rules WHERE policy_version_id = $1 ORDER BY consecutive_shifts', [r.id]);
  return {
    id: r.id,
    versionNo: r.version_no,
    maxDailyWorkMinutes: r.max_daily_work_minutes,
    maxWeeklyWorkMinutes: r.max_weekly_work_minutes,
    minDailyRestMinutes: r.min_daily_rest_minutes,
    maxConsecutiveWorkDays: r.max_consecutive_work_days,
    breaksPaid: r.breaks_paid,
    staffingCountsBreaks: r.staffing_counts_breaks,
    singleBranchPerDay: r.single_branch_per_day,
    breakGranularityMinutes: r.break_granularity_minutes,
    fairnessLookbackWeeks: r.fairness_lookback_weeks,
    weights: {
      preferredBranch: r.w_preferred_branch,
      preferredTime: r.w_preferred_time,
      fairHours: r.w_fair_hours,
      fairWeekends: r.w_fair_weekends,
      fairLate: r.w_fair_late,
      targetHours: r.w_target_hours,
      fragmentation: r.w_fragmentation,
      continuity: r.w_continuity,
    },
    breakRules: rules.map((x) => ({
      consecutiveShifts: x.consecutive_shifts,
      breakMinutes: x.break_minutes,
      earliestStartOffsetMinutes: x.earliest_start_offset_minutes,
      latestEndOffsetMinutes: x.latest_end_offset_minutes,
    })),
    note: r.note,
    createdAt: r.created_at,
  };
}

export const currentPolicyRow = (client: Db) => policyRow(client);

export function toEnginePolicy(v: PolicyView): Policy {
  return {
    versionId: v.id,
    maxDailyWorkMinutes: v.maxDailyWorkMinutes,
    maxWeeklyWorkMinutes: v.maxWeeklyWorkMinutes,
    minDailyRestMinutes: v.minDailyRestMinutes,
    maxConsecutiveWorkDays: v.maxConsecutiveWorkDays,
    breaksPaid: v.breaksPaid,
    staffingCountsBreaks: v.staffingCountsBreaks,
    singleBranchPerDay: v.singleBranchPerDay,
    breakGranularityMinutes: v.breakGranularityMinutes,
    fairnessLookbackWeeks: v.fairnessLookbackWeeks,
    weights: v.weights,
    breakRules: v.breakRules,
  };
}

/**
 * Compares the configured policy with the Dutch Arbeidstijdenwet figures for adult employees.
 * These are warnings for the administrator, not legal advice; a CAO may impose stricter rules.
 */
export function policyWarnings(v: PolicyView): string[] {
  const w: string[] = [];
  if (v.maxWeeklyWorkMinutes > 3600) w.push('The weekly maximum is above the 60 hours allowed by the Arbeidstijdenwet for adults.');
  if (v.maxDailyWorkMinutes > 720) w.push('The daily maximum is above the 12 hours per shift allowed by the Arbeidstijdenwet.');
  if (v.minDailyRestMinutes < 660)
    w.push('Daily rest below 11 hours is only allowed once per 7 days (minimum 8 hours) under the Arbeidstijdenwet. This system applies the value every day.');
  if (v.maxConsecutiveWorkDays > 6)
    w.push('With shifts ending at 21:00 and starting at 09:00, more than 6 working days in a row cannot give the 36 hours of weekly rest required by the Arbeidstijdenwet.');
  for (let n = 2; n <= 4; n++) {
    const rule = [...v.breakRules].sort((a, b) => a.consecutiveShifts - b.consecutiveShifts).filter((r) => r.consecutiveShifts <= n && r.breakMinutes > 0).pop();
    const brk = rule?.breakMinutes ?? 0;
    const work = n * 180 - (v.breaksPaid ? 0 : brk);
    if (work > 600 && brk < 45) w.push(`${n} consecutive shifts give more than 10 hours of work with less than 45 minutes of break (legal minimum).`);
    else if (work > 330 && brk < 30) w.push(`${n} consecutive shifts give more than 5.5 hours of work with less than 30 minutes of break (legal minimum).`);
  }
  if (!v.staffingCountsBreaks)
    w.push('Minimum staffing is checked against assigned staff only; the floor may be below minimum while people are on break.');
  return w;
}
