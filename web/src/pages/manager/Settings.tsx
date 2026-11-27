import { ClipboardText, Clock, GearSix, ListMagnifyingGlass, Plus, Scales, ShieldCheck, Sparkle, Trash, WarningCircle } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { Button, EmptyState, ErrorNotice, Field, Modal, PageLoader, Pill, SkillTag, Tabs, useToast } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { useSkills } from '../../lib/hooks';
import { instant } from '../../lib/time';

type Tab = 'policy' | 'profiles' | 'skills' | 'system' | 'audit';

export default function Settings() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('policy');
  if (!me.user.isAdmin) return <Navigate to="/manage" replace />;
  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <div>
          <h1>Rules &amp; settings</h1>
          <p className="lead">Every change is versioned and audited. Published schedules are never rewritten.</p>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'policy', label: 'Scheduling policy', icon: Scales },
          { value: 'profiles', label: 'Working-time profiles', icon: Clock },
          { value: 'skills', label: 'Skills', icon: Sparkle },
          { value: 'system', label: 'System', icon: GearSix },
          { value: 'audit', label: 'Audit log', icon: ListMagnifyingGlass },
        ]}
      />
      {tab === 'policy' && <Policy />}
      {tab === 'profiles' && <Profiles />}
      {tab === 'skills' && <Skills />}
      {tab === 'system' && <SystemSettings />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

const WEIGHTS: [string, string][] = [
  ['fairHours', 'Spread hours fairly'],
  ['targetHours', 'Stay close to contract hours'],
  ['preferredTime', 'Preferred shift times'],
  ['preferredBranch', 'Preferred branch'],
  ['fairWeekends', 'Share weekend shifts'],
  ['fairLate', 'Share late shifts'],
  ['fragmentation', 'Avoid split days'],
  ['continuity', 'Keep the same pattern as last week'],
];

function Policy() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['policy'], queryFn: () => api.get<any>('/api/policy') });
  const versions = useQuery({ queryKey: ['policy', 'versions'], queryFn: () => api.get<any[]>('/api/policy/versions') });
  const [p, setP] = useState<any | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (q.data) setP(structuredClone(q.data));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      api.put('/api/policy', {
        maxDailyWorkMinutes: p.maxDailyWorkMinutes,
        maxWeeklyWorkMinutes: p.maxWeeklyWorkMinutes,
        minDailyRestMinutes: p.minDailyRestMinutes,
        maxConsecutiveWorkDays: p.maxConsecutiveWorkDays,
        breaksPaid: p.breaksPaid,
        staffingCountsBreaks: p.staffingCountsBreaks,
        singleBranchPerDay: p.singleBranchPerDay,
        breakGranularityMinutes: p.breakGranularityMinutes,
        fairnessLookbackWeeks: p.fairnessLookbackWeeks,
        weights: p.weights,
        breakRules: p.breakRules,
        note: note || undefined,
      }),
    onSuccess: () => {
      toast.success('Policy saved as a new version', 'Drafts are validated against it now; published weeks keep their original version.');
      setNote('');
      void qc.invalidateQueries({ queryKey: ['policy'] });
      void qc.invalidateQueries({ queryKey: ['week'] });
    },
    onError: (e) => toast.error(e, 'Not saved'),
  });
  if (q.isLoading || !p) return <PageLoader />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const h = (m: number) => Math.round((m / 60) * 100) / 100;
  const setH = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: Math.round(Number(e.target.value) * 60) });
  return (
    <div className="stack lg">
      {q.data.warnings.length > 0 && (
        <div className="banner warn" role="status">
          <WarningCircle size={22} style={{ flex: 'none' }} />
          <div>
            <strong>Review against Dutch working-time law (current version {q.data.versionNo})</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{q.data.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul>
          </div>
        </div>
      )}
      <section className="card stack">
        <h2>Working time</h2>
        <p className="subtle">Company rules from the requirements, checked against the Arbeidstijdenwet for adults. A CAO may be stricter; confirm with HR.</p>
        <div className="form-grid">
          <Field label="Max. working hours per day" htmlFor="pd" hint="Company rule: 9"><input id="pd" type="number" step={0.25} className="input" value={h(p.maxDailyWorkMinutes)} onChange={setH('maxDailyWorkMinutes')} /></Field>
          <Field label="Max. working hours per week" htmlFor="pw" hint="Legal maximum for adults: 60"><input id="pw" type="number" step={0.5} className="input" value={h(p.maxWeeklyWorkMinutes)} onChange={setH('maxWeeklyWorkMinutes')} /></Field>
          <Field label="Min. rest between working days (hours)" htmlFor="pr" hint="Legal: 11"><input id="pr" type="number" step={0.5} className="input" value={h(p.minDailyRestMinutes)} onChange={setH('minDailyRestMinutes')} /></Field>
          <Field label="Max. consecutive working days" htmlFor="pc" hint="6 gives the legal 36 h weekly rest with these shift times"><input id="pc" type="number" className="input" value={p.maxConsecutiveWorkDays} onChange={(e) => setP({ ...p, maxConsecutiveWorkDays: Number(e.target.value) })} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={p.singleBranchPerDay} onChange={(e) => setP({ ...p, singleBranchPerDay: e.target.checked })} /> An employee works at only one branch per day</label>
      </section>
      <section className="card stack">
        <h2>Breaks</h2>
        <p className="subtle">Breaks are placed inside consecutive shifts without moving shift times, staggered so coverage stays at the minimum where possible.</p>
        {p.breakRules.map((r: any, i: number) => (
          <div key={i} className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Field label="Consecutive shifts" htmlFor={`bc${i}`}><select id={`bc${i}`} className="select" value={r.consecutiveShifts} onChange={(e) => setP({ ...p, breakRules: p.breakRules.map((x: any, j: number) => (j === i ? { ...x, consecutiveShifts: Number(e.target.value) } : x)) })}>{[2, 3, 4].map((n) => <option key={n} value={n}>{n} or more</option>)}</select></Field>
            <Field label="Break (minutes)" htmlFor={`bm${i}`}><input id={`bm${i}`} type="number" className="input" style={{ width: 120 }} value={r.breakMinutes} onChange={(e) => setP({ ...p, breakRules: p.breakRules.map((x: any, j: number) => (j === i ? { ...x, breakMinutes: Number(e.target.value) } : x)) })} /></Field>
            <Field label="Not before (min after start)" htmlFor={`be${i}`}><input id={`be${i}`} type="number" className="input" style={{ width: 150 }} value={r.earliestStartOffsetMinutes} onChange={(e) => setP({ ...p, breakRules: p.breakRules.map((x: any, j: number) => (j === i ? { ...x, earliestStartOffsetMinutes: Number(e.target.value) } : x)) })} /></Field>
            <Field label="Ends before (min before end)" htmlFor={`bl${i}`}><input id={`bl${i}`} type="number" className="input" style={{ width: 150 }} value={r.latestEndOffsetMinutes} onChange={(e) => setP({ ...p, breakRules: p.breakRules.map((x: any, j: number) => (j === i ? { ...x, latestEndOffsetMinutes: Number(e.target.value) } : x)) })} /></Field>
            <Button variant="ghost" icon={Trash} aria-label="Remove rule" onClick={() => setP({ ...p, breakRules: p.breakRules.filter((_: any, j: number) => j !== i) })} />
          </div>
        ))}
        {p.breakRules.length < 3 && <Button size="sm" icon={Plus} style={{ alignSelf: 'flex-start' }} onClick={() => setP({ ...p, breakRules: [...p.breakRules, { consecutiveShifts: 4, breakMinutes: 60, earliestStartOffsetMinutes: 120, latestEndOffsetMinutes: 60 }] })}>Add rule</Button>}
        <div className="form-grid">
          <Field label="Break placement step" htmlFor="bg"><select id="bg" className="select" value={p.breakGranularityMinutes} onChange={(e) => setP({ ...p, breakGranularityMinutes: Number(e.target.value) })}>{[5, 10, 15, 30].map((n) => <option key={n} value={n}>{n} minutes</option>)}</select></Field>
        </div>
        <label className="check"><input type="checkbox" checked={p.breaksPaid} onChange={(e) => setP({ ...p, breaksPaid: e.target.checked })} /> Breaks count as working time</label>
        <label className="check"><input type="checkbox" checked={p.staffingCountsBreaks} onChange={(e) => setP({ ...p, staffingCountsBreaks: e.target.checked })} /> Minimum staffing must hold on the floor during breaks (adds break relief)</label>
      </section>
      <section className="card stack">
        <h2>Fairness and preferences</h2>
        <p className="subtle">How strongly the generator weighs each factor among employees who already meet every rule (0 = ignore, 10 = very strong).</p>
        <div className="form-grid">
          {WEIGHTS.map(([k, label]) => (
            <Field key={k} label={`${label}: ${p.weights[k]}`} htmlFor={`w${k}`}>
              <input id={`w${k}`} type="range" min={0} max={10} step={0.5} value={p.weights[k]} onChange={(e) => setP({ ...p, weights: { ...p.weights, [k]: Number(e.target.value) } })} />
            </Field>
          ))}
          <Field label="History used for fairness (weeks)" htmlFor="lb"><input id="lb" type="number" min={0} max={52} className="input" value={p.fairnessLookbackWeeks} onChange={(e) => setP({ ...p, fairnessLookbackWeeks: Number(e.target.value) })} /></Field>
        </div>
      </section>
      <section className="card stack">
        <Field label="Reason for this change (saved with the version)" htmlFor="pn"><input id="pn" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        <div className="row end"><Button variant="primary" icon={ShieldCheck} loading={save.isPending} onClick={() => save.mutate()}>Save as new version</Button></div>
      </section>
      <section className="card">
        <h2 style={{ marginBottom: 10 }}>Versions</h2>
        {(versions.data ?? []).map((v) => (
          <div key={v.id} className="row between" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
            <span>Version {v.versionNo} <span className="subtle">{v.note ?? ''}</span></span>
            <span className="subtle">{v.createdBy ?? 'System'} · {instant(v.createdAt)}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function Profiles() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['wtp'], queryFn: () => api.get<any[]>('/api/working-time-profiles') });
  const [edit, setEdit] = useState<any | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: edit.name,
        description: edit.description || null,
        maxDailyWorkMinutes: edit.maxDailyHours ? Math.round(Number(edit.maxDailyHours) * 60) : null,
        maxWeeklyWorkMinutes: edit.maxWeeklyHours ? Math.round(Number(edit.maxWeeklyHours) * 60) : null,
        minDailyRestMinutes: edit.minRestHours ? Math.round(Number(edit.minRestHours) * 60) : null,
        maxConsecutiveWorkDays: edit.maxDays ? Number(edit.maxDays) : null,
        latestEndTime: edit.latestEndTime || null,
      };
      return edit.id ? api.put(`/api/working-time-profiles/${edit.id}`, body) : api.post('/api/working-time-profiles', body);
    },
    onSuccess: () => {
      toast.success('Profile saved');
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ['wtp'] });
    },
    onError: (e) => toast.error(e, 'Not saved'),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/working-time-profiles/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['wtp'] }), onError: (e) => toast.error(e) });
  const h = (m: number | null) => (m == null ? '' : m / 60);
  return (
    <div className="stack">
      <div className="banner info">
        <ClipboardText size={22} style={{ flex: 'none' }} />
        <span>Use profiles for employees who need stricter limits, for example workers under 18. No profile is created automatically: the right values depend on the employee's age and your CAO. The stricter of the profile and the company policy always applies.</span>
      </div>
      <div className="row end"><Button icon={Plus} variant="primary" onClick={() => setEdit({ name: '' })}>New profile</Button></div>
      {q.isLoading ? <PageLoader /> : !q.data?.length ? (
        <EmptyState icon={Clock} title="No working-time profiles">Everyone follows the company scheduling policy.</EmptyState>
      ) : (
        <div className="grid-2">
          {q.data.map((p) => (
            <div key={p.id} className="card stack sm">
              <div className="row between"><h3>{p.name}</h3><Pill>{p.employees} employees</Pill></div>
              {p.description && <p className="muted">{p.description}</p>}
              <p className="subtle">
                {[p.maxDailyWorkMinutes && `max ${h(p.maxDailyWorkMinutes)} h/day`, p.maxWeeklyWorkMinutes && `max ${h(p.maxWeeklyWorkMinutes)} h/week`, p.minDailyRestMinutes && `rest ${h(p.minDailyRestMinutes)} h`, p.maxConsecutiveWorkDays && `max ${p.maxConsecutiveWorkDays} days in a row`, p.latestEndTime && `end by ${p.latestEndTime}`].filter(Boolean).join(' · ') || 'No overrides'}
              </p>
              <div className="row">
                <Button size="sm" onClick={() => setEdit({ ...p, maxDailyHours: h(p.maxDailyWorkMinutes), maxWeeklyHours: h(p.maxWeeklyWorkMinutes), minRestHours: h(p.minDailyRestMinutes), maxDays: p.maxConsecutiveWorkDays ?? '' })}>Edit</Button>
                {p.employees === 0 && <Button size="sm" variant="ghost" icon={Trash} onClick={() => del.mutate(p.id)}>Delete</Button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit profile' : 'New working-time profile'} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!edit.name} onClick={() => save.mutate()}>Save</Button></>}>
          <div className="form-grid">
            <Field label="Name" htmlFor="wn"><input id="wn" className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Description" htmlFor="wd"><input id="wd" className="input" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <Field label="Max. hours per day" htmlFor="w1" hint="Empty = company policy"><input id="w1" type="number" step={0.25} className="input" value={edit.maxDailyHours ?? ''} onChange={(e) => setEdit({ ...edit, maxDailyHours: e.target.value })} /></Field>
            <Field label="Max. hours per week" htmlFor="w2"><input id="w2" type="number" step={0.5} className="input" value={edit.maxWeeklyHours ?? ''} onChange={(e) => setEdit({ ...edit, maxWeeklyHours: e.target.value })} /></Field>
            <Field label="Min. rest between days (hours)" htmlFor="w3"><input id="w3" type="number" step={0.5} className="input" value={edit.minRestHours ?? ''} onChange={(e) => setEdit({ ...edit, minRestHours: e.target.value })} /></Field>
            <Field label="Max. consecutive days" htmlFor="w4"><input id="w4" type="number" className="input" value={edit.maxDays ?? ''} onChange={(e) => setEdit({ ...edit, maxDays: e.target.value })} /></Field>
            <Field label="Latest end time" htmlFor="w5"><input id="w5" type="time" className="input" value={edit.latestEndTime ?? ''} onChange={(e) => setEdit({ ...edit, latestEndTime: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Skills() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useSkills();
  const [edit, setEdit] = useState<any | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: edit.name, kind: edit.kind, description: edit.description || null, colorIndex: Number(edit.colorIndex) };
      return edit.id ? api.patch(`/api/skills/${edit.id}`, { ...body, isActive: edit.isActive }) : api.post('/api/skills', body);
    },
    onSuccess: () => {
      toast.success('Skill saved');
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (e) => toast.error(e, 'Not saved'),
  });
  return (
    <div className="stack">
      <div className="row end"><Button icon={Plus} variant="primary" onClick={() => setEdit({ name: '', kind: 'skill', colorIndex: (q.data?.length ?? 0) % 8, isActive: true })}>New skill</Button></div>
      {!q.data?.length ? <EmptyState icon={Sparkle} title="No skills yet">Add the roles your supermarkets need, such as Cashier or Bakery.</EmptyState> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Skill</th><th>Type</th><th>Employees</th><th>Status</th><th /></tr></thead>
            <tbody>
              {q.data.map((s) => (
                <tr key={s.id}>
                  <td><SkillTag name={s.name} colorIndex={s.colorIndex} boxed /> {s.description && <div className="subtle">{s.description}</div>}</td>
                  <td>{s.kind === 'qualification' ? 'Qualification (can expire)' : 'Skill'}</td>
                  <td>{s.holders}</td>
                  <td>{s.isActive ? <Pill tone="green">Active</Pill> : <Pill>Inactive</Pill>}</td>
                  <td><Button size="sm" variant="ghost" onClick={() => setEdit({ ...s })}>Edit</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit skill' : 'New skill'} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!edit.name.trim()} onClick={() => save.mutate()}>Save</Button></>}>
          <div className="form-grid">
            <Field label="Name" htmlFor="sn"><input id="sn" className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Type" htmlFor="sk"><select id="sk" className="select" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}><option value="skill">Skill</option><option value="qualification">Qualification (with expiry date)</option></select></Field>
            <Field label="Description" htmlFor="sd"><input id="sd" className="input" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="label">Colour in the schedule</legend>
              <div className="row wrap">
                {Array.from({ length: 8 }, (_, i) => (
                  <label key={i} className="check" title={`Colour ${i + 1}`}>
                    <input type="radio" name="color" checked={Number(edit.colorIndex) === i} onChange={() => setEdit({ ...edit, colorIndex: i })} />
                    <span className="swatch" style={{ background: `var(--skill-${i})` }} />
                  </label>
                ))}
              </div>
            </fieldset>
            {edit.id && <label className="check"><input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> Active</label>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function SystemSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<any>('/api/settings') });
  const [s, setS] = useState<any | null>(null);
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.put('/api/settings', s),
    onSuccess: () => {
      toast.success('Settings saved');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => toast.error(e, 'Not saved'),
  });
  if (!s) return <PageLoader />;
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });
  return (
    <div className="card stack lg">
      <label className="check"><input type="checkbox" checked={s.allowEmployeeNameEdit} onChange={(e) => setS({ ...s, allowEmployeeNameEdit: e.target.checked })} /> Employees may edit their own first and last name</label>
      <div className="form-grid">
        <Field label="Temporary passwords expire after (hours)" htmlFor="s1"><input id="s1" type="number" className="input" value={s.tempPasswordTtlHours} onChange={num('tempPasswordTtlHours')} /></Field>
        <Field label="Sign out after inactivity (minutes)" htmlFor="s2"><input id="s2" type="number" className="input" value={s.sessionIdleMinutes} onChange={num('sessionIdleMinutes')} /></Field>
        <Field label="Maximum session length (days)" htmlFor="s3"><input id="s3" type="number" className="input" value={s.sessionAbsoluteDays} onChange={num('sessionAbsoluteDays')} /></Field>
        <Field label="Keep security events (days)" htmlFor="s4" hint="Older events are deleted automatically"><input id="s4" type="number" className="input" value={s.retentionSecurityEventsDays} onChange={num('retentionSecurityEventsDays')} /></Field>
        <Field label="Keep read notifications (days)" htmlFor="s5"><input id="s5" type="number" className="input" value={s.retentionNotificationsDays} onChange={num('retentionNotificationsDays')} /></Field>
      </div>
      <div className="row end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button></div>
    </div>
  );
}

function Audit() {
  const [kind, setKind] = useState<'audit' | 'security'>('audit');
  const [action, setAction] = useState('');
  const [pages, setPages] = useState<any[][]>([]);
  const q = useQuery({ queryKey: ['audit', kind, action], queryFn: () => api.get<any[]>(`/api/audit${qs({ kind, action: action || undefined })}`) });
  useEffect(() => setPages([]), [kind, action]);
  const rows = [...(q.data ?? []), ...pages.flat()];
  const more = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setPages([...pages, await api.get<any[]>(`/api/audit${qs({ kind, action: action || undefined, before: last.id })}`)]);
  };
  return (
    <div className="stack">
      <div className="row wrap">
        <select className="select sm" style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value as any)} aria-label="Log type">
          <option value="audit">Administrative actions</option>
          <option value="security">Security events</option>
        </select>
        <input className="input sm" style={{ maxWidth: 260 }} placeholder="Filter by action, e.g. schedule." value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action filter" />
      </div>
      {q.isLoading ? <PageLoader /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap subtle">{instant(r.createdAt)}</td>
                  <td>{r.actor ?? 'System'}{r.branch ? <div className="subtle">{r.branch}</div> : null}</td>
                  <td><code>{r.action}</code></td>
                  <td className="subtle" style={{ maxWidth: 420, wordBreak: 'break-word' }}>{r.details ? JSON.stringify(r.details).slice(0, 220) : ''}{r.ip ? ` · ${r.ip}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length >= 50 && <Button onClick={() => void more()} style={{ alignSelf: 'center' }}>Load older entries</Button>}
    </div>
  );
}
