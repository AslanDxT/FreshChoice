# Scheduling engine and workflows

The engine lives in `server/src/scheduling/` and has no database access, so every rule can be
unit-tested. The database layer (`server/src/services/schedule.ts`) loads its input and applies
its decisions with locking. Business decisions behind these rules are explained in
[REQUIREMENTS-ANALYSIS.md](REQUIREMENTS-ANALYSIS.md).

## Hard constraints (never broken)

Checked by `checkCandidate` for every single assignment before it is saved, by the generator before
it proposes anyone, and by the validator before publishing:

| Code | Rule |
|---|---|
| `ACCOUNT_INACTIVE` | Only active accounts can work. |
| `NOT_ELIGIBLE_BRANCH` | The person must have an active "can work here" membership for the branch. |
| `SICK` | Nobody is scheduled on a day they reported sick. |
| `AVAILABILITY_UNKNOWN` | No explicit *available* answer for that shift → not schedulable. Not submitted is never treated as available. |
| `UNAVAILABLE` | Marked unavailable → not schedulable. No override. |
| `ALREADY_ASSIGNED` | No overlapping shifts, in any branch (also guaranteed by a database constraint). |
| `OTHER_BRANCH_SAME_DAY` / `CONSECUTIVE_OTHER_BRANCH` | One branch per day (configurable); never back-to-back shifts at two branches. |
| `SKILL_MISSING` | A role can only be worked by someone with a valid (unexpired) skill. |
| `DAILY_LIMIT` | Actual working time per day ≤ 9 h (configurable; stricter profile wins). |
| `WEEKLY_LIMIT` | Working time per ISO week ≤ 60 h (configurable). |
| `REST_PERIOD` | ≥ 11 h between the end of one working day and the start of the next, measured in real time. |
| `CONSECUTIVE_DAYS` | ≤ 6 working days in a row (36 h weekly rest with these shift times). |
| `LATEST_END` | Working-time profile can forbid shifts ending after a given time. |

Shift-level requirements (minimum staff, minimum per role, coverage during breaks) cannot be met one
assignment at a time, so they do not block saving a draft; they **block publishing**.

## Working time and breaks

* A day's shifts are grouped into *blocks* of back-to-back shifts.
* Break per block = the break rule with the largest "consecutive shifts" ≤ block length
  (defaults: 2 → 30 min, 3 → 60 min; longer blocks use the 60-minute rule).
* Working time = presence − unpaid breaks. Examples: 2 consecutive = 5 h 30; 3 consecutive = 8 h;
  2 consecutive + 1 separate = 8 h 30; 4 shifts = 11 h, rejected by the 9-hour limit.

### Break placement (`breaks.ts`)

Shifts have no gaps, so a break is a slice of time inside the block. For each branch and day:

1. Build a 15-minute grid over the opening hours; count people on the floor and per role at each step.
2. Each break may start no earlier than 2 h after the block starts and must end at least 1 h before
   it ends (configurable per rule). If the window is impossible, the whole block is used and a
   `BREAK_WINDOW` warning is shown.
3. Least flexible breaks are placed first. For each possible start, the cost is the number of
   person-steps by which the break would take headcount, or role coverage, below the minimum.
   Ties are broken by fewest simultaneous breaks, then by closeness to the shift boundary in the
   middle of the block (for example 11:45–12:15 for a 09:00–15:00 block).
4. Any remaining stretch where breaks take the floor below the minimum is reported as
   `BREAK_COVERAGE` (an error while `staffing_counts_breaks` is on).

Breaks are stored (`break_assignments`), shown in the schedule (coffee icon and times) and to the
employee, copied into each published version, and recomputed after every change to that day.

## Generation (`generate.ts`)

Inputs loaded per branch and week: requirements per shift and role, every eligible employee with
skills, limits (policy combined with working-time profile, the stricter wins), preferences,
availability, assignments elsewhere (±14 days, all branches) for rest and weekly limits, sickness,
and history from published schedules over the look-back window (default 8 weeks).

1. Keep manual and cover assignments; in *Rebuild* mode remove earlier generated ones.
2. Repeat: compute every unmet need (a role seat, or a general seat). For each need, count the
   employees who pass every hard rule. Pick the need with the **least slack** (feasible people
   minus seats still open), role seats before general seats.
3. Fill it with the feasible employee with the **lowest score** (below). Hard rules decide who is
   allowed; the score only orders people who are all allowed, so a preference can never override a rule.
4. A need nobody can fill is marked blocked and explained later. If a role seat is blocked, general
   staff still fill the headcount.
5. Break relief: place breaks; where they would take coverage below the minimum, add the best
   feasible person (preferring people with no other shift that day, who need no break), repeat.
6. Validate the result and return every remaining problem with an explanation.

Feasibility results are cached per employee and invalidated when that employee gets a shift, which
keeps generation for a 60-person branch in seconds.

### Score (lower is better), weights configurable 0–10

| Factor | Meaning |
|---|---|
| Fair hours | Hours this week plus half the weekly average over the look-back window |
| Target hours | Distance to contract hours (strong penalty above contract) |
| Preferred time | Prefers / neutral / avoids this shift |
| Preferred branch | Rank 1–3, or not preferred |
| Weekend fairness | Weekend shifts recently and this week |
| Late shift fairness | Evening shifts recently and this week |
| Fragmentation | Avoids split days; favours extending an existing block |
| Continuity | Same weekday and shift as last week |
| Scarcity (fixed) | Keeps scarce-skill holders free for role seats |

### Explanations

* **Candidates** (`GET …/candidates?date&slot&roleSkillId`): every employee of the branch for one
  shift, feasible ones ranked with reasons ("Prefers this shift time", "12 h scheduled this week",
  "Below contract hours"), warnings (for example a break-coverage gap the person would cause), and
  the exact rule each infeasible person breaks.
* **Shortages**: `UNDERSTAFFED` / `SKILL_SHORTAGE` messages count why the others cannot work, for
  example "5 of 10 staff. Of the other employees: 9 have not submitted availability, 3 are
  unavailable, 2 would exceed the daily hour limit."
* Each generation, validation and publish attempt is stored in `scheduling_runs` with its issues.

## Validation and publication

* The validation report lists errors (block publishing), warnings and information (employees who
  have not submitted availability, available employees left unscheduled).
* **Publish** re-validates inside the transaction, requires the revision the manager reviewed,
  snapshots assignments and breaks into an immutable version, and notifies employees: everyone on
  first publication; only affected people (added, removed, role changed) afterwards, with the changes listed.
* Employees always see the latest published version. Edits after publishing stay in the manager's
  draft ("Publish changes") until published again.
* **Sickness** and **approved cover** change the published schedule immediately, by deriving a new
  version from the previous published one, so unpublished draft edits never leak to employees.
* Every version records the policy version it was validated under. Changing the policy creates a
  new policy version and never rewrites published schedules; the validation page says when a
  published week was checked under an older policy.

## Availability workflow

1. The employee picks a week or a month and taps shifts: **Available** (blue), **Unavailable**
   (red) or **Cancel**. Changes are a local draft marked "not submitted yet".
2. "Review and submit" lists every change; the server stores it as one submission and keeps the
   previous values in `availability_history`.
3. Confirmed shifts show green and cannot be set to unavailable (use Call Sick or Find Cover).
4. If availability is withdrawn for a week that already has a schedule, branch managers are notified.
5. Managers see every employee's week (filter by name, skill, submission status, available for a
   given shift, preferred time, preferred branch; sort by name, availability, submission), with
   notes, preferences and recent changes.

## Sickness workflow

1. Employee taps a confirmed shift → **Call Sick** (yellow); optionally includes the rest of that
   day and a practical note (no medical details are requested).
2. In one transaction: a sickness report is stored; the assignments are marked `sick` (kept for
   history); any open swap request is superseded; a replacement request (`kind = sickness`) is
   opened per shift; a new published version is derived; managers are notified.
3. The employee is ineligible for other work that day. The manager acknowledges the report and
   chooses a replacement, or closes the request without one.

## Cover workflow

States: **Open** → **Pending** (a colleague claimed it) → **Approved** (schedule updated) →
**Completed** (shift ended). Also **Rejected** (manager declined; requester keeps the shift) and
**Cancelled** (requester cancelled, assignment changed, or the shift started without a replacement).

1. Employee taps a confirmed shift → **Find Cover** (purple) → the Find Cover page grows out of the
   button (Grow Morph) with the shift preselected.
2. The system checks every colleague against every hard rule. A colleague needs the original role
   only if losing the requester would take that role below the shift's minimum; otherwise they can
   cover as general staff. Eligible colleagues are notified and see the request.
3. The first claim wins atomically; later claimants become backups ("interested").
4. The manager approves the claimant (or a backup, or chooses anyone eligible). A manager can only
   choose someone who submitted availability for that shift, unless the person offered themselves.
5. Approval re-checks all rules, marks the original `replaced`, creates the replacement, derives a
   new published version, records `replacement_history`, and notifies requester, replacement and
   other claimants. The original stays valid until this moment.
6. A background job cancels requests whose shift starts without approval (notifying managers for
   sickness cases) and completes approved ones after the shift ends.

## Notifications

Stored per recipient with read and resolved state, scoped to branch, linked to the relevant page,
and pushed live over the event stream. Types include schedule published/changed, sickness
reported, cover requested / opportunity / awaiting approval / claimed / approved / rejected / filled
/ cancelled / expired, availability withdrawn and announcements. Managers can mark items resolved;
handled items (approved cover, acknowledged sickness) resolve automatically.
