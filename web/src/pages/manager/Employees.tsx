import { Copy, Key, MagnifyingGlass, Plus, Prohibit, ShieldCheck, SignOut, Trash, UserPlus, UsersThree } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Avatar, Button, Confirm, Drawer, EmptyState, ErrorNotice, Field, Modal, PageLoader, Pill, SkillTag, Skeleton, useToast } from '../../components/ui';
import { BranchSwitcher, useBranch, useBranches } from '../../layouts/ManagerLayout';
import { api, qs } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { useSkills, type Skill } from '../../lib/hooks';
import { hours, instant } from '../../lib/time';

const STATUS_TONE: Record<string, any> = { active: 'green', suspended: 'amber', deactivated: 'neutral' };

export default function Employees() {
  const { branchId, branch } = useBranch();
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [skill, setSkill] = useState('');
  const [status, setStatus] = useState('active');
  const [scope, setScope] = useState<'branch' | 'all'>('branch');
  const [creating, setCreating] = useState(false);
  const skills = useSkills().data ?? [];
  const q = useQuery({
    queryKey: ['employees', scope === 'branch' ? branchId : 'all', search, skill, status],
    queryFn: () => api.get<any[]>(`/api/employees${qs({ branchId: scope === 'branch' ? branchId : undefined, q: search || undefined, skillId: skill || undefined, status })}`),
  });
  const openId = params.get('id');
  const setOpen = (id: string | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set('id', id);
    else p.delete('id');
    setParams(p, { replace: true });
  };
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Employees</h1>
          <p className="lead">{scope === 'branch' ? branch.name : 'All branches you manage'}</p>
        </div>
        <div className="row wrap">
          <BranchSwitcher />
          <Button variant="primary" icon={UserPlus} onClick={() => setCreating(true)}>
            New employee
          </Button>
        </div>
      </div>
      <div className="card tight" style={{ marginBottom: 16 }}>
        <div className="row wrap">
          <label className="row grow" style={{ gap: 6, minWidth: 220 }}>
            <MagnifyingGlass size={18} aria-hidden="true" />
            <input className="input sm" placeholder="Name or employee number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
          </label>
          <select className="select sm" value={skill} onChange={(e) => setSkill(e.target.value)} aria-label="Skill" style={{ width: 'auto' }}>
            <option value="">All skills</option>
            {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="select sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Account status" style={{ width: 'auto' }}>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="deactivated">Deactivated</option>
            <option value="all">Any status</option>
          </select>
          <select className="select sm" value={scope} onChange={(e) => setScope(e.target.value as any)} aria-label="Branch scope" style={{ width: 'auto' }}>
            <option value="branch">This branch</option>
            <option value="all">{me.user.isAdmin ? 'All branches' : 'All my branches'}</option>
          </select>
        </div>
      </div>
      {q.error && <ErrorNotice error={q.error} />}
      {q.isLoading ? (
        <Skeleton height={300} radius={20} />
      ) : !q.data?.length ? (
        <EmptyState icon={UsersThree} title={search || skill ? 'No matches' : 'No employees yet'} action={<Button icon={Plus} onClick={() => setCreating(true)}>Create the first account</Button>}>
          Each employee signs in with their employee number and a temporary password you hand over.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Number</th>
                <th>Branches</th>
                <th>Skills</th>
                <th>Account</th>
                <th>Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => setOpen(e.id)} tabIndex={0} onKeyDown={(k) => k.key === 'Enter' && setOpen(e.id)}>
                  <td>
                    <div className="row">
                      <Avatar name={`${e.firstName} ${e.lastName}`} userId={e.id} hasPhoto={e.hasPhoto} size={34} />
                      <div>
                        <strong>{e.firstName} {e.lastName}</strong>
                        {e.roles.includes('branch_manager') && <div className="subtle">Manager</div>}
                        {e.roles.includes('system_admin') && <div className="subtle">Administrator</div>}
                      </div>
                    </div>
                  </td>
                  <td className="tabular">{e.employeeNumber}</td>
                  <td className="subtle">{e.memberships.filter((m: any) => m.role === 'employee').map((m: any) => m.branchName).join(', ') || '–'}</td>
                  <td>
                    <div className="row wrap" style={{ gap: 6 }}>
                      {e.skills.map((s: any) => <SkillTag key={s.skillId} name={s.name} colorIndex={s.colorIndex} />)}
                    </div>
                  </td>
                  <td>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <Pill tone={STATUS_TONE[e.status]}>{e.status}</Pill>
                      {e.pendingFirstLogin && e.status === 'active' && <Pill tone="amber">First sign-in pending</Pill>}
                    </div>
                  </td>
                  <td className="subtle nowrap">{e.lastLoginAt ? instant(e.lastLoginAt) : 'Never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateEmployee onClose={() => setCreating(false)} onOpen={(id) => setOpen(id)} />}
      <Drawer open={!!openId} onClose={() => setOpen(null)} title="Employee">
        {openId && <EmployeeDetail id={openId} skills={skills} onClose={() => setOpen(null)} />}
      </Drawer>
    </div>
  );
}

function TempPassword({ value, expiresAt, name }: { value: string; expiresAt: string; name: string }) {
  const toast = useToast();
  return (
    <div className="stack">
      <div className="banner warn">
        <Key size={22} /> Shown once. Hand it to {name} in person; it cannot be displayed again. They must choose a new password when they first sign in.
      </div>
      <div className="temp-password" aria-label="Temporary password">{value}</div>
      <div className="row between wrap">
        <span className="subtle">Valid until {instant(expiresAt)}</span>
        <Button
          size="sm"
          icon={Copy}
          onClick={() =>
            navigator.clipboard?.writeText(value).then(
              () => toast.success('Copied'),
              () => toast.info('Copy failed', 'Select the password and copy it manually.'),
            )
          }
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

function CreateEmployee({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const me = useMe();
  const { branchId, branches } = useBranch();
  const allBranches = useBranches().data ?? [];
  const skills = useSkills().data ?? [];
  const profiles = useQuery({ queryKey: ['wtp'], queryFn: () => api.get<any[]>('/api/working-time-profiles') }).data ?? [];
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ employeeNumber: '', firstName: '', lastName: '', email: '', phone: '', homeBranchId: branchId, contractHours: '', workingTimeProfileId: '', accountType: 'employee', schedulable: true });
  const [extra, setExtra] = useState<string[]>([]);
  const [mgrBranches, setMgrBranches] = useState<string[]>([]);
  const [chosen, setChosen] = useState<{ skillId: string; isPrimary: boolean }[]>([]);
  const [result, setResult] = useState<any | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post('/api/employees', {
        employeeNumber: f.employeeNumber.trim(),
        firstName: f.firstName,
        lastName: f.lastName,
        email: f.email || null,
        phone: f.phone || null,
        homeBranchId: f.homeBranchId,
        extraBranchIds: extra.filter((x) => x !== f.homeBranchId),
        skills: chosen,
        contractWeeklyMinutes: f.contractHours ? Math.round(Number(f.contractHours) * 60) : null,
        workingTimeProfileId: f.workingTimeProfileId || null,
        accountType: f.accountType,
        managerBranchIds: f.accountType === 'branch_manager' ? mgrBranches : [],
        schedulable: f.schedulable,
      }),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['employees'] });
    },
    onError: (e) => toast.error(e, 'Account not created'),
  });
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  if (result) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Account created"
        footer={
          <>
            <Button onClick={() => { onClose(); onOpen(result.id); }}>View employee</Button>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </>
        }
      >
        <TempPassword value={result.temporaryPassword} expiresAt={result.expiresAt} name={f.firstName} />
        <p className="muted" style={{ marginTop: 12 }}>Sign-in ID: <strong>{f.employeeNumber}</strong></p>
      </Modal>
    );
  }
  const branchChoices = me.user.isAdmin ? allBranches.filter((b) => b.isActive) : branches;
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title="New employee account"
      description="A secure temporary password is generated. Only its hash is stored."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={UserPlus} loading={create.isPending} disabled={!f.employeeNumber || !f.firstName || !f.lastName || (f.accountType === 'branch_manager' && !mgrBranches.length)} onClick={() => create.mutate()}>
            Create account
          </Button>
        </>
      }
    >
      <div className="stack lg">
        <div className="form-grid">
          <Field label="Employee number" htmlFor="n" hint="Unique; used to sign in">
            <input id="n" className="input" value={f.employeeNumber} onChange={(e) => set('employeeNumber', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Home branch" htmlFor="hb">
            <select id="hb" className="select" value={f.homeBranchId} onChange={(e) => set('homeBranchId', e.target.value)}>
              {branchChoices.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="First name" htmlFor="fn"><input id="fn" className="input" value={f.firstName} onChange={(e) => set('firstName', e.target.value)} /></Field>
          <Field label="Last name" htmlFor="ln"><input id="ln" className="input" value={f.lastName} onChange={(e) => set('lastName', e.target.value)} /></Field>
          <Field label="Email" htmlFor="em" hint="Optional, used for password reset after verification"><input id="em" type="email" className="input" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="Phone" htmlFor="ph" hint="Optional"><input id="ph" type="tel" className="input" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field label="Contract hours per week" htmlFor="ch" hint="Optional, used for fair distribution"><input id="ch" type="number" min={0} max={80} step={0.5} className="input" value={f.contractHours} onChange={(e) => set('contractHours', e.target.value)} /></Field>
          <Field label="Working-time profile" htmlFor="wtp" hint="Stricter limits, e.g. for young workers">
            <select id="wtp" className="select" value={f.workingTimeProfileId} onChange={(e) => set('workingTimeProfileId', e.target.value)}>
              <option value="">Standard company policy</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
        <SkillPicker skills={skills} value={chosen} onChange={setChosen} />
        {me.user.isAdmin && (
          <section className="stack">
            <h3>Access (administrators only)</h3>
            <div className="row wrap">
              <label className="check"><input type="radio" checked={f.accountType === 'employee'} onChange={() => set('accountType', 'employee')} /> Employee</label>
              <label className="check"><input type="radio" checked={f.accountType === 'branch_manager'} onChange={() => set('accountType', 'branch_manager')} /> Branch manager</label>
            </div>
            {f.accountType === 'branch_manager' && (
              <>
                <span className="label">Manages</span>
                <div className="row wrap">
                  {allBranches.map((b) => (
                    <label key={b.id} className="check"><input type="checkbox" checked={mgrBranches.includes(b.id)} onChange={(e) => setMgrBranches(e.target.checked ? [...mgrBranches, b.id] : mgrBranches.filter((x) => x !== b.id))} /> {b.name}</label>
                  ))}
                </div>
                <label className="check"><input type="checkbox" checked={f.schedulable} onChange={(e) => set('schedulable', e.target.checked)} /> Can also be scheduled for shifts</label>
              </>
            )}
            <span className="label">Also eligible to work at</span>
            <div className="row wrap">
              {allBranches.filter((b) => b.id !== f.homeBranchId).map((b) => (
                <label key={b.id} className="check"><input type="checkbox" checked={extra.includes(b.id)} onChange={(e) => setExtra(e.target.checked ? [...extra, b.id] : extra.filter((x) => x !== b.id))} /> {b.name}</label>
              ))}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}

function SkillPicker({ skills, value, onChange }: { skills: Skill[]; value: { skillId: string; isPrimary: boolean; validUntil?: string | null }[]; onChange: (v: any[]) => void }) {
  const has = (id: string) => value.some((v) => v.skillId === id);
  return (
    <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="label" style={{ marginBottom: 6 }}>Skills and qualifications</legend>
      {!skills.length && <p className="subtle">No skills defined yet (Rules &amp; settings → Skills).</p>}
      <div className="row wrap">
        {skills.filter((s) => s.isActive).map((s) => (
          <label key={s.id} className="check" style={{ padding: '6px 10px', borderRadius: 999, background: has(s.id) ? 'var(--primary-soft)' : 'var(--surface-2)' }}>
            <input type="checkbox" checked={has(s.id)} onChange={(e) => onChange(e.target.checked ? [...value, { skillId: s.id, isPrimary: !value.length }] : value.filter((v) => v.skillId !== s.id))} />
            <SkillTag name={s.name} colorIndex={s.colorIndex} />
          </label>
        ))}
      </div>
      {value.length > 1 && (
        <Field label="Primary skill" htmlFor="prim">
          <select id="prim" className="select" value={value.find((v) => v.isPrimary)?.skillId ?? ''} onChange={(e) => onChange(value.map((v) => ({ ...v, isPrimary: v.skillId === e.target.value })))}>
            {value.map((v) => <option key={v.skillId} value={v.skillId}>{skills.find((s) => s.id === v.skillId)?.name}</option>)}
          </select>
        </Field>
      )}
    </fieldset>
  );
}

function EmployeeDetail({ id, skills, onClose }: { id: string; skills: Skill[]; onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const allBranches = useBranches().data ?? [];
  const profiles = useQuery({ queryKey: ['wtp'], queryFn: () => api.get<any[]>('/api/working-time-profiles') }).data ?? [];
  const q = useQuery({ queryKey: ['employee', id], queryFn: () => api.get<any>(`/api/employees/${id}`) });
  const [temp, setTemp] = useState<any | null>(null);
  const [confirm, setConfirm] = useState<null | 'deactivate' | 'suspend' | 'anonymize' | 'temp'>(null);
  const [anonConfirm, setAnonConfirm] = useState('');
  const [edit, setEdit] = useState<any | null>(null);
  const [skillEdit, setSkillEdit] = useState<any[] | null>(null);
  const [branchEdit, setBranchEdit] = useState<any[] | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['employee', id] });
    void qc.invalidateQueries({ queryKey: ['employees'] });
  };
  const mut = useMutation({
    mutationFn: ({ path, body, method = 'post' }: { path: string; body?: any; method?: 'post' | 'put' | 'patch' }) => (api as any)[method](`/api/employees/${id}${path}`, body ?? {}),
    onSuccess: (r: any, v) => {
      if (v.path === '/temporary-password') setTemp(r);
      else toast.success('Saved');
      setConfirm(null);
      setEdit(null);
      setSkillEdit(null);
      setBranchEdit(null);
      refresh();
    },
    onError: (e) => toast.error(e, 'Not saved'),
  });
  const e = q.data;
  const self = e?.id === me.user.id;
  const privileged = e?.roles?.some((r: string) => r === 'system_admin' || r === 'branch_manager');
  const canAdminister = !self && (me.user.isAdmin || !privileged);
  const profileName = useMemo(() => profiles.find((p) => p.id === e?.workingTimeProfileId)?.name, [profiles, e]);
  if (q.isLoading) return <PageLoader />;
  if (q.error || !e) return <ErrorNotice error={q.error} />;
  return (
    <div className="stack lg">
      <div className="row">
        <Avatar name={`${e.firstName} ${e.lastName}`} userId={e.id} hasPhoto={e.hasPhoto} size={56} />
        <div className="grow">
          <h2>{e.firstName} {e.lastName}</h2>
          <div className="row wrap" style={{ gap: 6 }}>
            <Pill tone={STATUS_TONE[e.status]}>{e.status}</Pill>
            {e.pendingFirstLogin && <Pill tone="amber">First sign-in pending</Pill>}
            {e.roles.includes('branch_manager') && <Pill tone="teal">Manager</Pill>}
            {e.roles.includes('system_admin') && <Pill tone="coral">Administrator</Pill>}
          </div>
        </div>
      </div>
      {temp && <TempPassword value={temp.temporaryPassword} expiresAt={temp.expiresAt} name={e.firstName} />}

      {edit ? (
        <div className="card flat stack">
          <div className="form-grid">
            <Field label="First name" htmlFor="efn"><input id="efn" className="input" value={edit.firstName} onChange={(x) => setEdit({ ...edit, firstName: x.target.value })} /></Field>
            <Field label="Last name" htmlFor="eln"><input id="eln" className="input" value={edit.lastName} onChange={(x) => setEdit({ ...edit, lastName: x.target.value })} /></Field>
            <Field label="Email" htmlFor="eem"><input id="eem" type="email" className="input" value={edit.email ?? ''} onChange={(x) => setEdit({ ...edit, email: x.target.value })} /></Field>
            <Field label="Phone" htmlFor="eph"><input id="eph" className="input" value={edit.phone ?? ''} onChange={(x) => setEdit({ ...edit, phone: x.target.value })} /></Field>
            <Field label="Contract hours per week" htmlFor="ech"><input id="ech" type="number" step={0.5} className="input" value={edit.contractHours} onChange={(x) => setEdit({ ...edit, contractHours: x.target.value })} /></Field>
            <Field label="Working-time profile" htmlFor="ewtp">
              <select id="ewtp" className="select" value={edit.workingTimeProfileId ?? ''} onChange={(x) => setEdit({ ...edit, workingTimeProfileId: x.target.value || null })}>
                <option value="">Standard company policy</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="row end">
            <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={mut.isPending}
              onClick={() =>
                mut.mutate({
                  path: '',
                  method: 'patch',
                  body: { firstName: edit.firstName, lastName: edit.lastName, email: edit.email || null, phone: edit.phone || null, contractWeeklyMinutes: edit.contractHours ? Math.round(Number(edit.contractHours) * 60) : null, workingTimeProfileId: edit.workingTimeProfileId },
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <dl className="dl">
          <dt>Employee number</dt><dd>{e.employeeNumber}</dd>
          <dt>Email</dt><dd>{e.email ?? '–'} {e.email && (e.emailVerified ? <Pill tone="green">Verified</Pill> : <Pill>Not verified</Pill>)}</dd>
          <dt>Phone</dt><dd>{e.phone ?? '–'}</dd>
          {e.address && (<><dt>Address</dt><dd>{[e.address.street, e.address.postalCode, e.address.city].filter(Boolean).join(', ') || '–'}</dd></>)}
          <dt>Contract</dt><dd>{e.contractWeeklyMinutes != null ? `${hours(e.contractWeeklyMinutes)} per week` : 'Not set'}</dd>
          <dt>Working-time profile</dt><dd>{profileName ?? 'Standard company policy'}</dd>
          <dt>Last sign-in</dt><dd>{e.lastLoginAt ? instant(e.lastLoginAt) : 'Never'}</dd>
        </dl>
      )}
      {canAdminister && !edit && (
        <Button size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => setEdit({ ...e, contractHours: e.contractWeeklyMinutes != null ? e.contractWeeklyMinutes / 60 : '' })}>
          Edit details
        </Button>
      )}

      <section className="stack">
        <div className="row between"><h3>Skills</h3>{!self && !skillEdit && <Button size="sm" variant="ghost" onClick={() => setSkillEdit(e.skills.map((s: any) => ({ skillId: s.skillId, isPrimary: s.isPrimary, validUntil: s.validUntil })))}>Edit</Button>}</div>
        {skillEdit ? (
          <>
            <SkillPicker skills={skills} value={skillEdit} onChange={setSkillEdit} />
            {skillEdit.filter((s) => skills.find((k) => k.id === s.skillId)?.kind === 'qualification').map((s) => (
              <Field key={s.skillId} label={`${skills.find((k) => k.id === s.skillId)?.name} valid until`} htmlFor={`vu${s.skillId}`}>
                <input id={`vu${s.skillId}`} type="date" className="input" value={s.validUntil ?? ''} onChange={(x) => setSkillEdit(skillEdit.map((y) => (y.skillId === s.skillId ? { ...y, validUntil: x.target.value || null } : y)))} />
              </Field>
            ))}
            <div className="row end">
              <Button variant="ghost" onClick={() => setSkillEdit(null)}>Cancel</Button>
              <Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate({ path: '/skills', method: 'put', body: { skills: skillEdit.map((s) => ({ skillId: s.skillId, isPrimary: s.isPrimary, validUntil: s.validUntil ?? null })) } })}>Save skills</Button>
            </div>
          </>
        ) : (
          <div className="row wrap">
            {e.skills.length ? e.skills.map((s: any) => <SkillTag key={s.skillId} name={`${s.name}${s.isPrimary ? ' (primary)' : ''}${s.validUntil ? ` until ${s.validUntil}` : ''}`} colorIndex={s.colorIndex} boxed />) : <span className="subtle">None</span>}
          </div>
        )}
      </section>

      <section className="stack">
        <div className="row between"><h3>Branches</h3>{me.user.isAdmin && !branchEdit && <Button size="sm" variant="ghost" onClick={() => setBranchEdit(e.memberships.filter((m: any) => m.isActive))}>Edit</Button>}</div>
        {branchEdit ? (
          <>
            {allBranches.map((b) => (
              <div key={b.id} className="row wrap">
                <strong style={{ minWidth: 140 }}>{b.name}</strong>
                {(['employee', 'manager'] as const).map((role) => {
                  const on = branchEdit.some((m) => m.branchId === b.id && m.role === role);
                  return (
                    <label key={role} className="check">
                      <input type="checkbox" checked={on} onChange={(x) => setBranchEdit(x.target.checked ? [...branchEdit, { branchId: b.id, role, canEditRequirements: true, canManageEmployees: true }] : branchEdit.filter((m) => !(m.branchId === b.id && m.role === role)))} />
                      {role === 'employee' ? 'Can work here' : 'Manages'}
                    </label>
                  );
                })}
              </div>
            ))}
            <div className="row end">
              <Button variant="ghost" onClick={() => setBranchEdit(null)}>Cancel</Button>
              <Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate({ path: '/branches', method: 'put', body: { memberships: branchEdit.map((m) => ({ branchId: m.branchId, role: m.role, canEditRequirements: m.canEditRequirements ?? true, canManageEmployees: m.canManageEmployees ?? true })) } })}>Save branches</Button>
            </div>
          </>
        ) : (
          <div className="row wrap">
            {e.memberships.filter((m: any) => m.isActive).map((m: any) => <Pill key={m.branchId + m.role} tone={m.role === 'manager' ? 'teal' : 'neutral'}>{m.branchName} · {m.role === 'manager' ? 'manages' : 'works'}</Pill>)}
          </div>
        )}
      </section>

      {canAdminister && (
        <section className="stack">
          <h3>Access</h3>
          <div className="row wrap">
            {e.status === 'active' && <Button size="sm" icon={Key} onClick={() => setConfirm('temp')}>New temporary password</Button>}
            {e.status === 'active' && <Button size="sm" icon={SignOut} onClick={() => mut.mutate({ path: '/revoke-sessions' })}>Sign out everywhere</Button>}
            {e.status === 'active' && <Button size="sm" icon={Prohibit} onClick={() => setConfirm('suspend')}>Suspend</Button>}
            {e.status !== 'active' && !e.isAnonymized && <Button size="sm" icon={ShieldCheck} onClick={() => mut.mutate({ path: '/status', body: { status: 'active' } })}>Reactivate</Button>}
            {e.status !== 'deactivated' && <Button size="sm" variant="danger" onClick={() => setConfirm('deactivate')}>Deactivate</Button>}
            {me.user.isAdmin && e.status === 'deactivated' && !e.isAnonymized && <Button size="sm" variant="danger" icon={Trash} onClick={() => setConfirm('anonymize')}>Erase personal data</Button>}
          </div>
          <p className="subtle">Deactivated accounts keep their schedule history. Erasing replaces personal data with an anonymous placeholder (GDPR).</p>
        </section>
      )}

      <Confirm open={confirm === 'temp'} onClose={() => setConfirm(null)} onConfirm={() => mut.mutate({ path: '/temporary-password' })} title="Issue a new temporary password?" confirmLabel="Issue" loading={mut.isPending}>
        <p>The current password stops working and {e.firstName} is signed out on every device.</p>
      </Confirm>
      <Confirm open={confirm === 'suspend' || confirm === 'deactivate'} onClose={() => setConfirm(null)} onConfirm={() => mut.mutate({ path: '/status', body: { status: confirm === 'suspend' ? 'suspended' : 'deactivated' } })} title={confirm === 'suspend' ? 'Suspend this account?' : 'Deactivate this account?'} confirmLabel={confirm === 'suspend' ? 'Suspend' : 'Deactivate'} danger loading={mut.isPending}>
        <p>{e.firstName} is signed out immediately and cannot sign in. Existing schedule history is kept. This can be undone.</p>
      </Confirm>
      <Confirm open={confirm === 'anonymize'} onClose={() => setConfirm(null)} onConfirm={() => mut.mutate({ path: '/anonymize', body: { confirmEmployeeNumber: anonConfirm } })} title="Erase personal data permanently?" confirmLabel="Erase" danger loading={mut.isPending}>
        <div className="stack">
          <p>Name, contact details, address, photo and preferences are removed. Schedule history stays, labelled as a former employee. This cannot be undone.</p>
          <Field label={`Type the employee number (${e.employeeNumber}) to confirm`} htmlFor="anon">
            <input id="anon" className="input" value={anonConfirm} onChange={(x) => setAnonConfirm(x.target.value)} />
          </Field>
        </div>
      </Confirm>
      <Button variant="ghost" onClick={onClose} style={{ alignSelf: 'flex-start' }}>Close</Button>
    </div>
  );
}
