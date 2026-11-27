# Requirements analysis: conflicts, gaps and decisions

This document records what was found when the Fresh Choice specification was studied before
implementation: rules that conflict, rules that are missing, and how each was resolved. Where the
specification leaves a business decision open, the rule is **configurable** and the default is
stated here, so an administrator can change it instead of the code inventing a policy.

Legend: **[LEGAL]** = derived from Dutch law (Arbeidstijdenwet, ATW). **[COMPANY]** = company policy
from the specification. **[DECISION]** = a resolution chosen by this implementation, configurable
unless stated otherwise.

---

## 1. Shift and break model

### 1.1 Consecutive shifts have no gap, but breaks are required (conflict)

The four shifts (09:00–12:00, 12:00–15:00, 15:00–18:00, 18:00–21:00) are back to back. The company
grants a 30-minute break for two consecutive shifts and 60 minutes for three. There is no gap in
which to take the break, and if exactly the minimum number of staff is scheduled, any break makes
the shift understaffed.

**Resolution [DECISION]**

* Shift times are never changed. A break is an explicit record (`break_assignments`) with a start
  and end instant **inside** the employee's consecutive block.
* Breaks are placed on a 15-minute grid inside a window: by default no earlier than 2 hours after
  the block starts and ending no later than 1 hour before the block ends (configurable per break
  rule).
* The break placer staggers breaks so that, at every 15-minute slot, the number of people **on the
  floor** (assigned and not on break) stays at or above the minimum, and role coverage (for example
  cashiers) stays at or above the skill minimum.
* Policy switch `staffing_counts_breaks` (default **on**): minimum staffing must hold on the floor
  during breaks. When it is on and staggering cannot keep coverage, the generator adds a
  *break-relief* employee to the shift, and the validator reports a `BREAK_COVERAGE` error until it
  is fixed. Switching it off makes the minimum apply to assigned headcount only.
* Breaks are unpaid and are not counted as working time unless `breaks_paid` is switched on.

### 1.2 Four consecutive shifts are not defined (gap)

The break rules stop at three consecutive shifts. Four shifts is 12 hours of presence. With any
break of 60 minutes or less that is 11+ hours of work, which exceeds the 9-hour daily limit, so the
combination can never be valid under the current rules.

**Resolution [DECISION]**: break rules are a table (`consecutive shifts → break minutes`); for
blocks longer than the longest rule, the longest rule applies. The 9-hour limit then rejects four
consecutive shifts. The validator explains this as `DAILY_LIMIT`.

### 1.3 What the 9-hour limit allows

With the defaults, the valid daily patterns are:

| Pattern | Presence | Break | Worked |
|---|---:|---:|---:|
| 1 shift | 3 h | 0 | 3 h |
| 2 consecutive | 6 h | 30 min | 5 h 30 |
| 2 split (e.g. 09–12 and 15–18) | 6 h | none (the gap is the pause) | 6 h |
| 3 consecutive | 9 h | 60 min | 8 h |
| 2 consecutive + 1 split | 9 h | 30 min | 8 h 30 |
| 4 shifts (any) | 12 h | ≤ 60 min | ≥ 11 h, rejected |

### 1.4 Split shifts across branches (gap)

The specification does not say whether an employee may work at two branches on one day. A
consecutive block split between two branches would have no travel time and a break that belongs to
neither branch.

**Resolution [DECISION]**: policy `single_branch_per_day` (default **on**). An employee works at
one branch per day. When switched off, the validator still forbids *consecutive* shifts at
different branches.

---

## 2. Dutch working-time law (ATW) versus company rules

The company rules were checked against the Arbeidstijdenwet as it applies to adult employees
(18+). No collective labour agreement (CAO) is assumed: a CAO, such as one for the supermarket
sector, can add stricter or different rules, and **must be checked by HR or a legal adviser** before
go-live. The numbers below should be confirmed against the official source
(rijksoverheid.nl / Nederlandse Arbeidsinspectie) at deployment time, because legislation can
change.

| Topic | ATW (adults) [LEGAL] | Company [COMPANY] | Result |
|---|---|---|---|
| Max per shift (dienst) | 12 h | 9 h/day | Company is stricter. Enforced: 9 h. |
| Max per week | 60 h | not specified | Enforced as a hard limit: 60 h (configurable, never above the legal figure without a warning). |
| Average per week | 48 h over 16 weeks | not specified | **Not checked automatically in this version.** With a 9 h day and at most 6 days per week it is reachable only with sustained 54 h weeks; HR should monitor it until a 16-week report is added. |
| Break | > 5.5 h work: 30 min; > 10 h: 45 min | 2 consecutive: 30 min; 3 consecutive: 60 min | Company meets or exceeds the law for consecutive blocks. A split day (09–12, 15–18) has a 3 h pause between parts, which satisfies the law. |
| Daily rest | 11 h per 24 h (once per 7 days may be 8 h) | not specified | Enforced: 11 h. Fixed shift times always give ≥ 12 h, except the night clocks go forward (21:00 → 09:00 is 11 real hours), which still passes. Rest is computed on real instants, not wall-clock times. |
| Weekly rest | 36 h per 7 days, or 72 h per 14 days | not specified | With shifts ending 21:00 and starting 09:00, one full day off gives exactly 36 h. Enforced as `max_consecutive_work_days` = 6 (configurable). |

### 2.1 Young workers (under 18)

The law is considerably stricter for workers under 18 (for example, shorter maximum shift and week,
longer daily rest, earlier latest end time, break after 4.5 h, and further limits under 16). The
specification forbids assuming an age category, and collecting dates of birth only to compute this
is not necessary.

**Resolution [DECISION]**: *working-time profiles*. An administrator can create profiles (for
example "Under 18") with their own maximum daily and weekly working time, minimum daily rest,
latest end time and maximum consecutive working days, and assign a profile to an employee. The
scheduler always applies the stricter of the profile and the global policy. No profile is created
automatically, because the correct values depend on the CAO and the employee's exact age; HR must
enter them.

### 2.2 Conflicts flagged for administrator review

* **Exactly-minimum staffing and breaks.** See 1.1. If managers want exactly 10 people and also
  breaks inside the shift, there will be moments with 9 on the floor. The default policy treats
  this as an error; the administrator can relax it knowingly.
* **Weekly maximum above 60 h.** The settings page warns if an administrator sets a weekly limit
  above the ATW maximum.
* **Break rules below the legal minimum.** The settings page warns if a break rule gives less than
  30 minutes for blocks over 5.5 hours of work, or less than 45 minutes over 10 hours.

---

## 3. Availability

| Question | Resolution |
|---|---|
| Is "not submitted" the same as available? | No. The generator never assigns an employee without an explicit *available* entry for that shift. Managers see "not submitted" separately. |
| Can a manager assign someone marked unavailable? | No. It is a hard constraint and cannot be overridden. The employee must change their availability first. |
| Preference versus availability | Preferences (branch, shift times) are stored separately and only affect ranking among available employees. A preference never overrides "unavailable". |
| Can an employee withdraw availability after being scheduled? | Not for a confirmed (published) shift: that must go through Call Sick or Find Cover. For other shifts they can change availability at any time. If they withdraw a shift that is only in a draft, the draft's validation report shows the conflict, which blocks publishing until the manager fixes it. When the week already has a schedule, the branch manager is notified. |
| Weekly versus monthly submission | Both are supported. Entries are stored per date and shift; a later submission replaces earlier values for the same shift, and the history is kept. |
| Deadlines | The specification mentions "scheduling deadlines" but gives none. A manager can set an *availability deadline* per weekly schedule; it appears on the dashboard and on employees' home pages. No default deadline is invented. |
| Cover claims by employees without submitted availability | Claiming a cover shift is an explicit statement of availability, so it is allowed, and it records an *available* entry for that shift. Employees marked *unavailable* cannot claim. |

---

## 4. Skills and roles

* Skills and qualifications are one catalogue with a `kind` (skill or qualification).
  Qualifications can have an expiry date; an expired qualification does not count.
* Each assignment has an optional **role** (the skill the person covers in that shift). Skill
  coverage counts roles, not every skill a person happens to have. Otherwise one person with both
  cashier and bakery skills would satisfy both requirements at the same moment.
* A role can only be one of the employee's valid skills (hard constraint).
* Skills are a global catalogue. Skill *requirements* are per branch, weekday and shift.

---

## 5. Staffing requirements

* Per branch, weekday (Mon–Sun) and shift: a minimum headcount. When a branch is created, all 28
  cells get the branch's default minimum (10 for the large branch and 6 for the smaller ones, as
  entered during setup).
* Per branch, weekday, shift and skill: a minimum number of people working in that role. There are
  no skill requirements until a manager or administrator enters them; the specification gives no
  numbers.
* The schedule grid shows the minimum as pairs of stacked seats (10 → five pairs, 6 → three pairs).
  Extra people beyond the minimum are shown as additional pairs.

---

## 6. Schedules, publication and versions

* A schedule covers one branch and one ISO week (Monday–Sunday, `Europe/Amsterdam`).
* Saving an assignment checks every per-employee hard constraint immediately (availability, skill,
  branch eligibility, overlap, daily limit, rest, weekly limit, consecutive days, single branch per
  day). An invalid assignment is never saved.
* Shift-level problems (understaffing, missing role coverage, break coverage) can exist while a
  draft is being built. They **block publication**.
* Publishing creates an immutable version snapshot. Employees always see the latest published
  snapshot; edits made afterwards stay in the manager's working copy until "Publish changes",
  which creates a new version, works out who is affected and notifies them.
* Approved cover replacements and sickness reports change a published schedule immediately. They
  create a new version derived from the previous published one, so unpublished draft edits are not
  leaked to employees.
* Publication is protected by a revision number: if the working copy changed after the manager's
  last validation, publishing is refused until they review again.
* Policy changes never rewrite published schedules. Each version records the policy version it was
  validated against; the validation page shows when a published week would fail under the current
  policy.

---

## 7. Sickness and cover

* Sickness reports collect no medical information: only the affected shift(s) and an optional
  practical note.
* A sickness report marks the assignment *sick* (kept, not deleted), notifies the branch manager,
  opens a replacement request, and makes the employee ineligible for any new assignment on that
  date. The manager acknowledges the report.
* Cover request states: **Open** (looking for a colleague), **Pending** (a colleague claimed it;
  waiting for the manager), **Approved** (manager approved; schedule updated), **Rejected** (manager
  refused the request), **Cancelled** (withdrawn, or the shift started without cover), **Completed**
  (the approved shift has ended).
* Only one colleague can hold the claim at a time. The claim is a single conditional database
  update, so concurrent claims cannot both succeed. Others can register interest as backups.
* The original assignment stays valid until the manager approves the replacement. Approval
  re-checks every hard constraint inside the same transaction.

---

## 8. Accounts and privacy

| Question | Resolution |
|---|---|
| Who can see a residential address? | The employee and system administrators only. Branch managers do not need it for scheduling. |
| Who can see phone and email? | The employee, administrators, and managers of a branch the employee belongs to. |
| Can employees edit their name? | System setting `allow_employee_name_edit`, default **off** (names usually come from HR records). |
| Email change | Requires the current password. Password-reset emails are only sent to verified addresses. |
| Password reset without email | If no SMTP server is configured, email reset is unavailable and an administrator or manager issues a new temporary password instead. |
| Leaving employees | Accounts are deactivated, not deleted, so schedule history stays intact. An administrator can anonymise a former employee (GDPR right to erasure): personal data is cleared, the schedule history keeps an anonymous placeholder. |
| Managers working shifts | A manager can also hold an employee membership in a branch and is then schedulable like anyone else. |
| Login identifier | Employee number or email address, plus password. |

---

## 9. Items deliberately not invented

* Branch names, addresses and the list of skills: entered during setup or later (setup offers
  "Cashier" and "Bakery" from the specification as removable suggestions).
* Contract hours: optional per employee, entered by a manager.
* Skill minimums per shift.
* Availability deadlines.
* Working-time profiles for young workers.
* Any employee, announcement, schedule or notification data.
