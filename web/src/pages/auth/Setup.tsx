import { Buildings, Key, Plus, Sparkle, Trash, UserCircleGear } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Button, Field, PageLoader, Pill } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { AuthCard, PasswordHints } from './AuthCard';

interface BranchRow {
  name: string;
  defaultMinStaff: number;
  expectedHeadcount: number | null;
}

// Staffing figures come from the business requirements; names are entered by the administrator.
const DEFAULT_BRANCHES: BranchRow[] = [
  { name: '', defaultMinStaff: 10, expectedHeadcount: 60 },
  { name: '', defaultMinStaff: 6, expectedHeadcount: 30 },
  { name: '', defaultMinStaff: 6, expectedHeadcount: 30 },
];

export default function Setup() {
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get('/api/setup/status') });
  const qc = useQueryClient();
  const nav = useNavigate();
  const [token, setToken] = useState('');
  const [admin, setAdmin] = useState({ employeeNumber: '', firstName: '', lastName: '', email: '', password: '', repeat: '' });
  const [branches, setBranches] = useState<BranchRow[]>(DEFAULT_BRANCHES);
  const [skills, setSkills] = useState<string[]>(['Cashier', 'Bakery']);
  const [newSkill, setNewSkill] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status.isLoading) return <PageLoader />;
  if (!status.data?.needsSetup) return <Navigate to="/login" replace />;
  if (!status.data.webSetupEnabled) {
    return (
      <AuthCard title="Set up Fresh Choice" subtitle="Browser setup is switched off on this server.">
        <div className="stack">
          <p>Create the first administrator from the server's command line:</p>
          <pre className="card flat tight" style={{ overflowX: 'auto', margin: 0 }}>docker compose exec app node dist/src/cli/create-admin.js</pre>
          <p className="subtle">Or set SETUP_TOKEN in the server environment, restart, and reload this page. See docs/DEPLOYMENT.md.</p>
        </div>
      </AuthCard>
    );
  }

  const setB = (i: number, patch: Partial<BranchRow>) => setBranches((b) => b.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (admin.password !== admin.repeat) return setError('The passwords do not match.');
    if (branches.some((b) => !b.name.trim())) return setError('Give every branch a name, or remove the empty row.');
    setBusy(true);
    try {
      await api.post('/api/setup', {
        setupToken: token,
        admin: { employeeNumber: admin.employeeNumber, firstName: admin.firstName, lastName: admin.lastName, email: admin.email || undefined, password: admin.password },
        branches: branches.map((b) => ({ ...b, name: b.name.trim() })),
        skills,
      });
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['setup-status'] });
      nav('/manage', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard wide title="Set up Fresh Choice" subtitle="Create the first administrator and your branches. This page only works once, with the setup token from your server configuration.">
      <form className="stack lg" onSubmit={submit}>
        <section className="stack">
          <h3 className="row"><Key size={20} /> Setup token</h3>
          <Field label="SETUP_TOKEN from the server environment" htmlFor="tok">
            <input id="tok" className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />
          </Field>
        </section>
        <hr className="soft" />
        <section className="stack">
          <h3 className="row"><UserCircleGear size={20} /> Administrator account</h3>
          <div className="form-grid">
            <Field label="Login ID / employee number" htmlFor="en">
              <input id="en" className="input" autoComplete="username" value={admin.employeeNumber} onChange={(e) => setAdmin({ ...admin, employeeNumber: e.target.value })} required />
            </Field>
            <Field label="Email (for password reset)" htmlFor="em" hint="Optional">
              <input id="em" className="input" type="email" autoComplete="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} />
            </Field>
            <Field label="First name" htmlFor="fn">
              <input id="fn" className="input" autoComplete="given-name" value={admin.firstName} onChange={(e) => setAdmin({ ...admin, firstName: e.target.value })} required />
            </Field>
            <Field label="Last name" htmlFor="ln">
              <input id="ln" className="input" autoComplete="family-name" value={admin.lastName} onChange={(e) => setAdmin({ ...admin, lastName: e.target.value })} required />
            </Field>
            <Field label="Password" htmlFor="pw" hint={<PasswordHints />}>
              <input id="pw" className="input" type="password" autoComplete="new-password" value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} required />
            </Field>
            <Field label="Repeat password" htmlFor="pw2">
              <input id="pw2" className="input" type="password" autoComplete="new-password" value={admin.repeat} onChange={(e) => setAdmin({ ...admin, repeat: e.target.value })} required />
            </Field>
          </div>
        </section>
        <hr className="soft" />
        <section className="stack">
          <h3 className="row"><Buildings size={20} /> Branches</h3>
          <p className="subtle">Minimum staff per shift and expected headcount are pre-filled from the business requirements (one large branch, two smaller ones). You can change them, and add skill requirements later.</p>
          {branches.map((b, i) => (
            <div key={i} className="row wrap card flat tight" style={{ alignItems: 'flex-end' }}>
              <Field label={`Branch ${i + 1} name`} htmlFor={`bn${i}`}>
                <input id={`bn${i}`} className="input" value={b.name} onChange={(e) => setB(i, { name: e.target.value })} required placeholder="Branch name" />
              </Field>
              <Field label="Min. staff per shift" htmlFor={`bm${i}`}>
                <input id={`bm${i}`} className="input" type="number" min={1} max={200} value={b.defaultMinStaff} onChange={(e) => setB(i, { defaultMinStaff: Number(e.target.value) })} style={{ width: 130 }} />
              </Field>
              <Field label="Employees (approx.)" htmlFor={`bh${i}`}>
                <input id={`bh${i}`} className="input" type="number" min={0} value={b.expectedHeadcount ?? ''} onChange={(e) => setB(i, { expectedHeadcount: e.target.value ? Number(e.target.value) : null })} style={{ width: 130 }} />
              </Field>
              {branches.length > 1 && (
                <Button type="button" variant="ghost" icon={Trash} onClick={() => setBranches(branches.filter((_, j) => j !== i))} aria-label={`Remove branch ${i + 1}`} />
              )}
            </div>
          ))}
          <Button type="button" icon={Plus} onClick={() => setBranches([...branches, { name: '', defaultMinStaff: 6, expectedHeadcount: null }])} style={{ alignSelf: 'flex-start' }}>
            Add branch
          </Button>
        </section>
        <hr className="soft" />
        <section className="stack">
          <h3 className="row"><Sparkle size={20} /> Starter skills</h3>
          <p className="subtle">Suggested from the requirements. Remove any you do not need; more can be added later.</p>
          <div className="row wrap">
            {skills.map((s) => (
              <button type="button" key={s} className="pill coral" onClick={() => setSkills(skills.filter((x) => x !== s))} aria-label={`Remove ${s}`} style={{ border: 0, cursor: 'pointer' }}>
                {s} <Trash size={14} />
              </button>
            ))}
            {!skills.length && <Pill>No skills</Pill>}
          </div>
          <div className="row">
            <input className="input" value={newSkill} onChange={(e) => setNewSkill(e.target.value)} placeholder="Add a skill, e.g. Deli" aria-label="New skill name" />
            <Button
              type="button"
              icon={Plus}
              onClick={() => {
                const v = newSkill.trim();
                if (v && !skills.includes(v)) setSkills([...skills, v]);
                setNewSkill('');
              }}
            >
              Add
            </Button>
          </div>
        </section>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <Button variant="primary" size="lg" type="submit" loading={busy}>
          Create administrator and branches
        </Button>
      </form>
    </AuthCard>
  );
}
