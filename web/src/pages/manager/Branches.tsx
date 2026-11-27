import { Buildings, PencilSimple, Plus, Sliders } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button, EmptyState, ErrorNotice, Field, Modal, PageLoader, Pill, SkillTag, useToast } from '../../components/ui';
import { useBranches, type BranchInfo } from '../../layouts/ManagerLayout';
import { api } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { useSkills } from '../../lib/hooks';
import { SHIFTS } from '../../lib/time';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Branches() {
  const me = useMe();
  const q = useBranches();
  const [edit, setEdit] = useState<BranchInfo | 'new' | null>(null);
  const [reqFor, setReqFor] = useState<BranchInfo | null>(null);
  const canReq = (id: string) => me.user.isAdmin || me.memberships.some((m) => m.branchId === id && m.role === 'manager' && m.canEditRequirements);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Branches</h1>
          <p className="lead">Branch details, staffing minimums and skill requirements.</p>
        </div>
        {me.user.isAdmin && (
          <Button variant="primary" icon={Plus} onClick={() => setEdit('new')}>
            New branch
          </Button>
        )}
      </div>
      {q.error && <ErrorNotice error={q.error} />}
      {q.isLoading ? (
        <PageLoader />
      ) : !q.data?.filter((b) => b.managed).length ? (
        <EmptyState icon={Buildings} title="No branches">
          {me.user.isAdmin ? 'Create your first branch.' : 'You do not manage any branch yet.'}
        </EmptyState>
      ) : (
        <div className="grid-3">
          {q.data
            .filter((b) => b.managed)
            .map((b) => (
              <article key={b.id} className="card stack">
                <div className="row between">
                  <h2>{b.name}</h2>
                  {b.isActive ? <Pill tone="green">Active</Pill> : <Pill>Inactive</Pill>}
                </div>
                {b.address && <p className="muted">{b.address}</p>}
                <dl className="dl">
                  <dt>Default minimum</dt>
                  <dd>{b.defaultMinStaff} per shift</dd>
                  <dt>Employees</dt>
                  <dd>
                    {b.employeeCount}
                    {b.expectedHeadcount ? ` of about ${b.expectedHeadcount}` : ''}
                  </dd>
                  <dt>Managers</dt>
                  <dd>{b.managers?.length ? b.managers.map((m) => m.name).join(', ') : 'None assigned'}</dd>
                </dl>
                <div className="row wrap">
                  {canReq(b.id) && (
                    <Button size="sm" icon={Sliders} onClick={() => setReqFor(b)}>
                      Staffing requirements
                    </Button>
                  )}
                  {me.user.isAdmin && (
                    <Button size="sm" variant="ghost" icon={PencilSimple} onClick={() => setEdit(b)}>
                      Edit
                    </Button>
                  )}
                </div>
              </article>
            ))}
        </div>
      )}
      {edit && <BranchForm branch={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {reqFor && <Requirements branch={reqFor} onClose={() => setReqFor(null)} />}
    </div>
  );
}

function BranchForm({ branch, onClose }: { branch: BranchInfo | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    name: branch?.name ?? '',
    code: branch?.code ?? '',
    address: branch?.address ?? '',
    defaultMinStaff: branch?.defaultMinStaff ?? 6,
    expectedHeadcount: branch?.expectedHeadcount ?? '',
    isActive: branch?.isActive ?? true,
  });
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name, code: f.code || null, address: f.address || null, defaultMinStaff: Number(f.defaultMinStaff), expectedHeadcount: f.expectedHeadcount === '' ? null : Number(f.expectedHeadcount) };
      return branch ? api.patch(`/api/branches/${branch.id}`, { ...body, isActive: f.isActive }) : api.post('/api/branches', body);
    },
    onSuccess: () => {
      toast.success(branch ? 'Branch updated' : 'Branch created', branch ? undefined : 'All shifts start with the default minimum; adjust them under Staffing requirements.');
      void qc.invalidateQueries({ queryKey: ['branches'] });
      onClose();
    },
    onError: (e) => toast.error(e, 'Not saved'),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={branch ? `Edit ${branch.name}` : 'New branch'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={!f.name.trim()} onClick={() => m.mutate()}>Save</Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name" htmlFor="bn"><input id="bn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Short code" htmlFor="bc" hint="Optional, letters and digits"><input id="bc" className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={12} /></Field>
        <Field label="Address" htmlFor="ba" hint="Optional"><input id="ba" className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label="Default minimum staff per shift" htmlFor="bm" hint={branch ? 'Existing requirements are not changed.' : undefined}><input id="bm" type="number" min={1} className="input" value={f.defaultMinStaff} onChange={(e) => setF({ ...f, defaultMinStaff: Number(e.target.value) })} /></Field>
        <Field label="Expected number of employees" htmlFor="bh"><input id="bh" type="number" min={0} className="input" value={f.expectedHeadcount} onChange={(e) => setF({ ...f, expectedHeadcount: e.target.value as any })} /></Field>
        {branch && (
          <label className="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Branch is active
          </label>
        )}
      </div>
    </Modal>
  );
}

function Requirements({ branch, onClose }: { branch: BranchInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const skills = useSkills().data ?? [];
  const q = useQuery({ queryKey: ['requirements', branch.id], queryFn: () => api.get<any>(`/api/branches/${branch.id}/requirements`) });
  const [staff, setStaff] = useState<Record<string, number>>({});
  const [skillReq, setSkillReq] = useState<Record<string, Record<string, number>>>({});
  const [skillTab, setSkillTab] = useState('');
  useEffect(() => {
    if (!q.data) return;
    setStaff(Object.fromEntries(q.data.staffing.map((s: any) => [`${s.weekday}:${s.slot}`, s.minStaff])));
    const sk: Record<string, Record<string, number>> = {};
    for (const r of q.data.skills) (sk[r.skillId] ??= {})[`${r.weekday}:${r.slot}`] = r.minCount;
    setSkillReq(sk);
  }, [q.data]);
  useEffect(() => {
    if (!skillTab && skills.length) setSkillTab(skills[0].id);
  }, [skills, skillTab]);
  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/branches/${branch.id}/requirements`, {
        staffing: Object.entries(staff).map(([k, v]) => ({ weekday: Number(k.split(':')[0]), slot: Number(k.split(':')[1]), minStaff: Number(v) || 0 })),
        skills: Object.entries(skillReq).flatMap(([skillId, cells]) =>
          Object.entries(cells)
            .filter(([, v]) => Number(v) > 0)
            .map(([k, v]) => ({ skillId, weekday: Number(k.split(':')[0]), slot: Number(k.split(':')[1]), minCount: Number(v) })),
        ),
      }),
    onSuccess: () => {
      toast.success('Requirements saved', 'Schedules are validated against them straight away.');
      void qc.invalidateQueries({ queryKey: ['requirements', branch.id] });
      void qc.invalidateQueries({ queryKey: ['week'] });
      onClose();
    },
    onError: (e) => toast.error(e, 'Not saved'),
  });
  const fillAll = (v: number) => setStaff(Object.fromEntries(Object.keys(staff).map((k) => [k, v])));
  const cur = skillReq[skillTab] ?? {};
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={`Staffing requirements · ${branch.name}`}
      description="Minimum people per shift, and how many of them must work in a specific role."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()} disabled={!q.data}>Save requirements</Button>
        </>
      }
    >
      {q.isLoading ? (
        <PageLoader />
      ) : (
        <div className="stack lg">
          <section className="stack">
            <div className="row between wrap">
              <h3>Minimum staff</h3>
              <div className="row">
                <span className="subtle">Set every shift to</span>
                <input className="input sm" type="number" min={0} style={{ width: 80 }} aria-label="Value for all shifts" onKeyDown={(e) => e.key === 'Enter' && fillAll(Number((e.target as HTMLInputElement).value))} onBlur={(e) => e.target.value && fillAll(Number(e.target.value))} />
              </div>
            </div>
            <Grid values={staff} onChange={(k, v) => setStaff({ ...staff, [k]: v })} label="minimum staff" />
          </section>
          <section className="stack">
            <h3>Role requirements</h3>
            {!skills.length ? (
              <p className="subtle">Create skills first under Rules &amp; settings.</p>
            ) : (
              <>
                <div className="row wrap">
                  {skills.filter((s) => s.isActive).map((s) => (
                    <button key={s.id} className={`pill ${skillTab === s.id ? 'coral' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => setSkillTab(s.id)} aria-pressed={skillTab === s.id}>
                      <SkillTag name={s.name} colorIndex={s.colorIndex} />
                    </button>
                  ))}
                </div>
                <Grid values={cur} onChange={(k, v) => setSkillReq({ ...skillReq, [skillTab]: { ...cur, [k]: v } })} label={`${skills.find((s) => s.id === skillTab)?.name} minimum`} allowEmpty />
                <p className="subtle">Leave empty or 0 when the role is not required. Role minimums count toward the shift minimum.</p>
              </>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

function Grid({ values, onChange, label, allowEmpty }: { values: Record<string, number>; onChange: (k: string, v: number) => void; label: string; allowEmpty?: boolean }) {
  return (
    <div className="req-grid" role="grid" aria-label={label}>
      <span />
      {SHIFTS.map((s) => (
        <span key={s.slot} className="subtle" style={{ textAlign: 'center' }}>{s.start}</span>
      ))}
      {DAYS.map((d, i) => (
        <FragmentRow key={d} d={d} wd={i + 1} values={values} onChange={onChange} label={label} allowEmpty={allowEmpty} />
      ))}
    </div>
  );
}

function FragmentRow({ d, wd, values, onChange, label, allowEmpty }: { d: string; wd: number; values: Record<string, number>; onChange: (k: string, v: number) => void; label: string; allowEmpty?: boolean }) {
  return (
    <>
      <strong>{d}</strong>
      {SHIFTS.map((s) => {
        const k = `${wd}:${s.slot}`;
        return (
          <input
            key={k}
            className="input"
            type="number"
            min={0}
            max={200}
            value={values[k] ?? (allowEmpty ? '' : 0)}
            onChange={(e) => onChange(k, e.target.value === '' ? 0 : Number(e.target.value))}
            aria-label={`${d} ${s.start} ${label}`}
          />
        );
      })}
    </>
  );
}
