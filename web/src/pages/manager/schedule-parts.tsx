/** Building blocks of the manager schedule: shift cells, candidate list, assignment actions. */
import {
  ArrowsLeftRight,
  CheckCircle,
  Coffee,
  FirstAidKit,
  Info,
  Plus,
  Sparkle,
  Trash,
  UserSwitch,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Button, Confirm, Drawer, EmptyState, Field, Modal, Pill, SkillTag, SquareMorph, useToast } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { type Issue, type Skill, type WeekAssignment, type WeekData } from '../../lib/hooks';
import { dayMonth, fullDate, hours, shiftTime, weekdayName, weekdayShort } from '../../lib/time';

export function shortName(full: string) {
  const parts = full.split(' ');
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : full;
}

export function cellData(data: WeekData, date: string, slot: number) {
  const req = data.requirements.find((r) => r.date === date && r.slot === slot);
  const cov = data.coverage.find((c) => c.date === date && c.slot === slot);
  const all = data.assignments.filter((a) => a.date === date && a.slot === slot);
  const active = all.filter((a) => a.status === 'active');
  const sick = all.filter((a) => a.status === 'sick');
  const replaced = all.filter((a) => a.status === 'replaced').length;
  const issues = data.issues.filter((i) => i.date === date && i.slot === slot && i.severity !== 'info');
  return { req, cov, active, sick, replaced, issues, min: req?.minStaff ?? 0 };
}

/* ------------------------------------------------------------ employee card */
export function EmployeeCard({ a, skills, breakText, onClick }: { a: WeekAssignment; skills: Map<string, Skill>; breakText?: string; onClick: () => void }) {
  const role = a.roleSkillId ? skills.get(a.roleSkillId) : null;
  const roleLabel = role?.name ?? a.primarySkill ?? 'General';
  const colorIndex = role?.colorIndex ?? (a.primarySkill ? [...skills.values()].find((s) => s.name === a.primarySkill)?.colorIndex : undefined);
  const flags: string[] = [];
  if (a.status === 'sick') flags.push('Reported sick');
  if (a.cover) flags.push(a.cover.kind === 'sickness' ? 'Replacement needed' : `Cover ${a.cover.status}`);
  if (breakText) flags.push(`Break ${breakText}`);
  if (a.source === 'cover') flags.push('Covering a shift');
  return (
    <button
      type="button"
      className={`emp-card ${a.status} ${a.source === 'cover' ? 'covering' : ''}`}
      style={{ ['--skill-color' as any]: colorIndex != null ? `var(--skill-${colorIndex})` : undefined }}
      onClick={onClick}
      aria-label={`${a.name}, ${role ? `role ${role.name}` : 'general'}${flags.length ? `, ${flags.join(', ')}` : ''}`}
      title={[a.name, ...flags].join(' · ')}
    >
      <span className="nm truncate">{a.name}</span>
      <span className="meta">
        <span className="truncate" style={{ fontWeight: role ? 650 : 500, color: role ? 'var(--text)' : undefined }}>{roleLabel}</span>
      </span>
      <span className="flags" aria-hidden="true">
        {breakText && <Coffee size={14} />}
        {a.status === 'sick' && <FirstAidKit size={14} style={{ color: 'var(--yellow-ink)' }} />}
        {a.cover && <ArrowsLeftRight size={14} style={{ color: 'var(--purple-ink)' }} />}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------ shift cell */
export function ShiftCell({
  data,
  date,
  slot,
  skills,
  highlight,
  onSeat,
  onCard,
}: {
  data: WeekData;
  date: string;
  slot: number;
  skills: Map<string, Skill>;
  highlight?: boolean;
  onSeat: (date: string, slot: number, roleSkillId?: string | null) => void;
  onCard: (a: WeekAssignment) => void;
}) {
  const c = cellData(data, date, slot);
  const ordered = [...c.active].sort((x, y) => Number(!x.roleSkillId) - Number(!y.roleSkillId) || (x.roleSkillId ?? '').localeCompare(y.roleSkillId ?? '') || x.name.localeCompare(y.name));
  const open = Math.max(0, c.min - c.active.length);
  // Seats: assigned people, then open seats up to the minimum, padded to full pairs (two stacked per pair).
  const items: ({ kind: 'a'; a: WeekAssignment } | { kind: 'open'; missing: boolean } | { kind: 'sick'; a: WeekAssignment } | { kind: 'spacer' })[] = [
    ...ordered.map((a) => ({ kind: 'a' as const, a })),
    ...Array.from({ length: open }, () => ({ kind: 'open' as const, missing: true })),
    ...c.sick.map((a) => ({ kind: 'sick' as const, a })),
  ];
  if (items.length === 0) items.push({ kind: 'open', missing: false });
  if (items.length % 2 === 1) items.push({ kind: 'spacer' });
  const breakFor = (userId: string) => {
    const b = data.breaks.find((x) => x.userId === userId && x.date === date);
    if (!b) return undefined;
    const t = data.templates.find((t) => t.slot === slot)!;
    return b.start < t.end && b.end > t.start ? `${b.start}–${b.end}` : undefined;
  };
  const ok = c.cov?.ok ?? c.active.length >= c.min;
  const skillGaps = c.cov?.skills ?? [];
  return (
    <div className={`wg-cell ${!ok && c.min > 0 ? 'short' : ''} ${highlight ? 'highlight' : ''}`} id={`cell-${date}-${slot}`}>
      <div className="cell-meta">
        <span className={`cover-meter ${ok ? 'ok' : 'bad'}`}>
          {ok ? <CheckCircle size={17} weight="regular" /> : <WarningCircle size={17} weight="regular" />}
          <span className="tabular">
            {c.active.length} / {c.min}
          </span>
          <span className="sr-only">{ok ? 'staffing requirements met' : 'requirements not met'}</span>
        </span>
        <span className="skill-cov">
          {skillGaps.map((s) => {
            const sk = skills.get(s.skillId);
            return (
              <Pill key={s.skillId} tone={s.have >= s.need ? 'green' : 'amber'} title={`${sk?.name}: ${s.have} of ${s.need}`}>
                {sk?.name} {s.have}/{s.need}
              </Pill>
            );
          })}
          {c.replaced > 0 && <Pill title="Replaced through cover">{c.replaced} replaced</Pill>}
          {open === 0 && c.active.length > 0 && (
            <button type="button" className="icon-btn sm" onClick={() => onSeat(date, slot)} aria-label={`Add employee, ${weekdayName(date)} ${shiftTime(slot)}`} title="Add employee">
              <Plus size={16} />
            </button>
          )}
        </span>
      </div>
      <div className="pairs">
        {items.map((it, i) =>
          it.kind === 'spacer' ? (
            <span key={`s${i}`} aria-hidden="true" />
          ) : it.kind === 'open' ? (
            <button key={`o${i}`} type="button" className={`seat-open ${it.missing ? 'missing' : ''}`} onClick={() => onSeat(date, slot)} aria-label={`${it.missing ? 'Open seat' : 'Add employee'}, ${weekdayName(date)} ${shiftTime(slot)}`}>
              <Plus size={16} /> {it.missing ? 'Open seat' : 'Add'}
            </button>
          ) : (
            <EmployeeCard key={it.a.id} a={it.a} skills={skills} breakText={breakFor(it.a.userId)} onClick={() => onCard(it.a)} />
          ),
        )}
      </div>
      {c.issues.length > 0 && (
        <div className="subtle" style={{ color: 'var(--amber-ink)' }}>
          <WarningCircle size={14} style={{ verticalAlign: -2 }} /> {c.issues.length} issue{c.issues.length > 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- candidates */
interface Candidate {
  userId: string;
  name: string;
  feasible: boolean;
  violations: { code: string; message: string }[];
  availability: 'available' | 'unavailable' | 'not_submitted';
  weekWorkMinutes: number;
  score: { total: number } | null;
  reasons: string[];
  warnings: string[];
}

const AV: Record<string, { tone: any; label: string; icon: any }> = {
  available: { tone: 'blue', label: 'Available', icon: CheckCircle },
  unavailable: { tone: 'red', label: 'Unavailable', icon: XCircle },
  not_submitted: { tone: 'neutral', label: 'Not submitted', icon: Info },
};

export function CandidatesDrawer({
  open,
  onClose,
  branchId,
  weekStart,
  date,
  slot,
  data,
  skills,
  replace,
}: {
  open: boolean;
  onClose: () => void;
  branchId: string;
  weekStart: string;
  date: string;
  slot: number;
  data: WeekData;
  skills: Map<string, Skill>;
  replace?: WeekAssignment | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const req = data.requirements.find((r) => r.date === date && r.slot === slot);
  const [role, setRole] = useState<string>(replace?.roleSkillId ?? '');
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({
    queryKey: ['candidates', branchId, weekStart, date, slot, role],
    queryFn: () => api.get<Candidate[]>(`/api/branches/${branchId}/weeks/${weekStart}/candidates?date=${date}&slot=${slot}${role ? `&roleSkillId=${role}` : ''}`),
    enabled: open,
  });
  const assign = useMutation({
    mutationFn: (userId: string) =>
      replace ? api.patch(`/api/assignments/${replace.id}`, { userId, roleSkillId: role || null }) : api.post(`/api/branches/${branchId}/weeks/${weekStart}/assignments`, { userId, date, slot, roleSkillId: role || null }),
    onSuccess: (_r, userId) => {
      const n = q.data?.find((c) => c.userId === userId)?.name;
      toast.success(replace ? 'Replaced' : 'Assigned', `${n} · ${weekdayName(date)} ${shiftTime(slot)}`);
      void qc.invalidateQueries({ queryKey: ['week', branchId, weekStart] });
      void qc.invalidateQueries({ queryKey: ['candidates'] });
      if (replace) onClose();
    },
    onError: (e) => toast.error(e, 'Could not assign'),
  });
  const feasible = (q.data ?? []).filter((c) => c.feasible && (!replace || c.userId !== replace.userId));
  const blocked = (q.data ?? []).filter((c) => !c.feasible);
  const roleOptions = useMemo(() => {
    const needed = new Set(req?.skills.map((s) => s.skillId));
    return [...skills.values()].filter((s) => s.isActive).sort((a, b) => Number(needed.has(b.id)) - Number(needed.has(a.id)) || a.name.localeCompare(b.name));
  }, [skills, req]);
  return (
    <Drawer open={open} onClose={onClose} title={replace ? `Replace ${replace.name}` : 'Add to shift'}>
      <div className="stack">
        <p className="muted">
          {fullDate(date)} · {shiftTime(slot)}
        </p>
        <Field label="Role in this shift" htmlFor="role" hint="Coverage for a skill only counts people working in that role.">
          <select id="role" className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">General (no specific role)</option>
            {roleOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {req?.skills.some((x) => x.skillId === s.id) ? ' (required here)' : ''}
              </option>
            ))}
          </select>
        </Field>
        {q.isLoading && <SquareMorph label="Ranking employees" />}
        {q.data && (
          <>
            <h3 className="row">
              <Sparkle size={20} /> Suggested ({feasible.length})
            </h3>
            {!feasible.length && (
              <EmptyState icon={UserSwitch} title="Nobody can take this shift">
                Every employee breaks at least one rule for this shift. See the reasons below.
              </EmptyState>
            )}
            <div>
              {feasible.map((c, i) => (
                <div key={c.userId} className="cand">
                  <div className="grow">
                    <div className="row wrap" style={{ gap: 8 }}>
                      <strong>{c.name}</strong>
                      {i === 0 && !c.warnings.length && <Pill tone="coral">Best match</Pill>}
                      <Pill tone={AV[c.availability].tone} icon={AV[c.availability].icon}>
                        {AV[c.availability].label}
                      </Pill>
                      <span className="subtle">{hours(c.weekWorkMinutes)} this week</span>
                    </div>
                    <ul className="reasons">
                      {c.reasons.slice(1).map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                    {c.warnings.map((w) => (
                      <div key={w} className="subtle" style={{ color: 'var(--amber-ink)', marginTop: 4 }}>
                        <WarningCircle size={14} style={{ verticalAlign: -2 }} /> {w}
                      </div>
                    ))}
                  </div>
                  <Button size="sm" variant={i === 0 ? 'primary' : 'default'} loading={assign.isPending && assign.variables === c.userId} onClick={() => assign.mutate(c.userId)}>
                    {replace ? 'Replace' : 'Assign'}
                  </Button>
                </div>
              ))}
            </div>
            <button className="btn ghost sm" onClick={() => setShowAll((s) => !s)} aria-expanded={showAll} style={{ alignSelf: 'flex-start' }}>
              {showAll ? 'Hide' : 'Show'} employees who cannot work this shift ({blocked.length})
            </button>
            {showAll &&
              blocked.map((c) => (
                <div key={c.userId} className="cand no">
                  <div className="grow">
                    <div className="row wrap" style={{ gap: 8 }}>
                      <strong>{c.name}</strong>
                      <Pill tone={AV[c.availability].tone} icon={AV[c.availability].icon}>
                        {AV[c.availability].label}
                      </Pill>
                    </div>
                    <ul className="reasons">
                      {c.violations.map((v) => (
                        <li key={v.code + v.message}>{v.message}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
          </>
        )}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------- assignment modal */
export function AssignmentModal({
  a,
  onClose,
  data,
  skills,
  branchId,
  onReplace,
}: {
  a: WeekAssignment | null;
  onClose: () => void;
  data: WeekData;
  skills: Map<string, Skill>;
  branchId: string;
  onReplace: (a: WeekAssignment) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [target, setTarget] = useState('');
  const emp = a ? data.employees.find((e) => e.id === a.userId) : null;
  const [role, setRole] = useState<string | null>(null);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['week', branchId, data.weekStart] });
    onClose();
  };
  const remove = useMutation({
    mutationFn: () => api.del(`/api/assignments/${a!.id}`),
    onSuccess: () => {
      toast.success('Removed from shift');
      setConfirm(false);
      done();
    },
    onError: (e) => toast.error(e, 'Could not remove'),
  });
  const update = useMutation({
    mutationFn: (body: any) => api.patch(`/api/assignments/${a!.id}`, body),
    onSuccess: () => {
      toast.success('Shift updated');
      done();
    },
    onError: (e) => toast.error(e, 'Could not change the shift'),
  });
  if (!a) return null;
  const brk = data.breaks.find((b) => b.userId === a.userId && b.date === a.date);
  const roleValue = role ?? a.roleSkillId ?? '';
  const editable = a.status === 'active';
  return (
    <>
      <Modal
        open={!!a}
        onClose={onClose}
        title={a.name}
        description={
          <>
            {weekdayName(a.date)} {dayMonth(a.date)} · {shiftTime(a.slot)} · #{a.employeeNumber}
          </>
        }
      >
        <div className="stack">
          <div className="row wrap">
            {a.status === 'sick' && <Pill tone="yellow" icon={FirstAidKit}>Reported sick</Pill>}
            {a.source === 'cover' && <Pill tone="purple" icon={ArrowsLeftRight}>Covering</Pill>}
            {a.cover && <Pill tone="purple" icon={ArrowsLeftRight}>{a.cover.kind === 'sickness' ? 'Replacement needed' : `Cover request: ${a.cover.status}`}</Pill>}
            {brk && <Pill tone="teal" icon={Coffee}>Break {brk.start}–{brk.end}</Pill>}
            {emp && <Pill>{hours(emp.weekWorkMinutes)} this week{emp.contractWeeklyMinutes ? ` of ${hours(emp.contractWeeklyMinutes)}` : ''}</Pill>}
          </div>
          {editable ? (
            <>
              <Field label="Role in this shift" htmlFor="arole">
                <div className="row">
                  <select id="arole" className="select" value={roleValue} onChange={(e) => setRole(e.target.value)}>
                    <option value="">General</option>
                    {(emp?.skills ?? []).map((id) => (
                      <option key={id} value={id}>
                        {skills.get(id)?.name}
                      </option>
                    ))}
                  </select>
                  <Button disabled={roleValue === (a.roleSkillId ?? '')} loading={update.isPending && update.variables?.roleSkillId !== undefined} onClick={() => update.mutate({ roleSkillId: roleValue || null })}>
                    Save
                  </Button>
                </div>
              </Field>
              <Field label="Move to another shift this week" htmlFor="amove">
                <div className="row">
                  <select id="amove" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">Choose a shift…</option>
                    {data.dates.flatMap((d) =>
                      data.templates
                        .filter((t) => !(d === a.date && t.slot === a.slot))
                        .map((t) => (
                          <option key={`${d}:${t.slot}`} value={`${d}:${t.slot}`}>
                            {weekdayShort(d)} {dayMonth(d)} · {t.start}–{t.end}
                          </option>
                        )),
                    )}
                  </select>
                  <Button
                    disabled={!target}
                    loading={update.isPending && update.variables?.slot !== undefined}
                    onClick={() => {
                      const [date, slot] = target.split(':');
                      update.mutate({ date, slot: Number(slot) });
                    }}
                  >
                    Move
                  </Button>
                </div>
              </Field>
              <p className="subtle">Every change is checked against availability, skills, working-time limits and rest rules before it is saved.</p>
            </>
          ) : (
            <p className="muted">This assignment is kept for history and cannot be edited. Replacements are handled under Cover.</p>
          )}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <Link className="btn ghost" to={`/manage/employees?branch=${branchId}&id=${a.userId}`}>
            Employee details
          </Link>
          {editable && (
            <div className="row">
              <Button icon={UserSwitch} onClick={() => onReplace(a)}>
                Replace
              </Button>
              <Button variant="danger" icon={Trash} onClick={() => setConfirm(true)}>
                Remove
              </Button>
            </div>
          )}
        </div>
      </Modal>
      <Confirm open={confirm} onClose={() => setConfirm(false)} onConfirm={() => remove.mutate()} title="Remove from this shift?" confirmLabel="Remove" danger loading={remove.isPending}>
        <p>
          {a.name} will be removed from {weekdayName(a.date)} {shiftTime(a.slot)}. If the week is published, the change stays in your draft until you publish again.
        </p>
      </Confirm>
    </>
  );
}

/* ------------------------------------------------------------ issues */
export function IssueList({ issues, onJump }: { issues: Issue[]; onJump?: (i: Issue) => void }) {
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity] || (a.date ?? '').localeCompare(b.date ?? '') || (a.slot ?? 0) - (b.slot ?? 0));
  if (!sorted.length)
    return (
      <EmptyState icon={CheckCircle} title="No problems found">
        Staffing, skills, breaks and every employee rule are satisfied.
      </EmptyState>
    );
  return (
    <div>
      {sorted.map((i, k) => {
        const Ico = i.severity === 'error' ? XCircle : i.severity === 'warning' ? WarningCircle : Info;
        return (
          <div key={k} className={`issue ${i.severity}`}>
            <Ico size={20} style={{ flex: 'none', marginTop: 1 }} />
            <div className="grow">
              {onJump && i.date ? (
                <button className="linkish" onClick={() => onJump(i)}>
                  {i.message}
                </button>
              ) : (
                i.message
              )}
              <div className="subtle">
                {i.severity === 'error' ? 'Must be fixed before publishing' : i.severity === 'warning' ? 'Warning' : 'Information'} · {i.code.replaceAll('_', ' ').toLowerCase()}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function apiErrorIssues(e: unknown): Issue[] | null {
  return e instanceof ApiError && e.details?.issues ? (e.details.issues as Issue[]) : null;
}
