import { Camera, DeviceMobile, EnvelopeSimple, LockKey, Minus, SignOut, ThumbsDown, ThumbsUp, Trash } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Avatar, Button, ErrorNotice, Field, Modal, PageLoader, Pill, SkillTag, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth, useMe } from '../../lib/auth';
import { hours, instant, shiftTime, SHIFTS } from '../../lib/time';
import { ChangePasswordForm } from '../auth/ChangePassword';

export default function Profile() {
  const me = useMe();
  const { setMe } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['profile'], queryFn: () => api.get<any>('/api/me/profile') });
  const [f, setF] = useState<any | null>(null);
  const [photoKey, setPhotoKey] = useState(0);
  const [emailOpen, setEmailOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (q.data)
      setF({
        firstName: q.data.firstName,
        lastName: q.data.lastName,
        phone: q.data.phone ?? '',
        addressStreet: q.data.address?.street ?? '',
        addressPostalCode: q.data.address?.postalCode ?? '',
        addressCity: q.data.address?.city ?? '',
        preferredBranches: q.data.preferredBranches,
        shiftPreferences: Object.fromEntries(q.data.shiftPreferences.map((s: any) => [s.slot, s.preference])),
      });
  }, [q.data]);

  const saveDetails = useMutation({
    mutationFn: () =>
      api.patch('/api/me/profile', {
        ...(me.features.allowNameEdit || me.user.isAdmin ? { firstName: f.firstName, lastName: f.lastName } : {}),
        phone: f.phone,
        addressStreet: f.addressStreet,
        addressPostalCode: f.addressPostalCode,
        addressCity: f.addressCity,
      }),
    onSuccess: () => {
      toast.success('Profile saved');
      void qc.invalidateQueries({ queryKey: ['profile'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(e, 'Not saved'),
  });
  const savePrefs = useMutation({
    mutationFn: () =>
      api.put('/api/me/preferences', {
        preferredBranches: f.preferredBranches,
        shiftPreferences: Object.entries(f.shiftPreferences).map(([slot, preference]) => ({ slot: Number(slot), preference })),
      }),
    onSuccess: () => toast.success('Preferences saved', 'They help the scheduler, but never override your availability.'),
    onError: (e) => toast.error(e, 'Not saved'),
  });
  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.upload('/api/me/photo', fd);
    },
    onSuccess: () => {
      toast.success('Photo updated');
      setPhotoKey((k) => k + 1);
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (e) => toast.error(e, 'Photo not saved'),
  });
  const removePhoto = useMutation({
    mutationFn: () => api.del('/api/me/photo'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['profile'] }),
  });

  if (q.isLoading || !f) return <PageLoader />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const p = q.data;
  const eligible = p.memberships.filter((m: any) => m.role === 'employee' && m.isActive);
  const nameEditable = me.features.allowNameEdit || me.user.isAdmin;

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-head"><h1>My profile</h1></div>
      <div className="stack lg">
        <section className="card row wrap" style={{ gap: 20 }}>
          <div key={photoKey}><Avatar name={`${p.firstName} ${p.lastName}`} userId={p.id} hasPhoto={p.hasPhoto} size={96} /></div>
          <div className="stack sm grow">
            <h2>{p.firstName} {p.lastName}</h2>
            <span className="muted">Employee number {p.employeeNumber}</span>
            <div className="row wrap">
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) { if (file.size > 5 * 1024 * 1024) toast.error(null, 'The image is larger than 5 MB'); else upload.mutate(file); } e.target.value = ''; }} />
              <Button size="sm" icon={Camera} loading={upload.isPending} onClick={() => fileRef.current?.click()}>{p.hasPhoto ? 'Change photo' : 'Add photo'}</Button>
              {p.hasPhoto && <Button size="sm" variant="ghost" icon={Trash} onClick={() => removePhoto.mutate()}>Remove</Button>}
            </div>
            <span className="subtle">JPEG, PNG or WebP up to 5 MB. Location data and other metadata are removed.</span>
          </div>
        </section>

        <section className="card stack">
          <h2>Personal details</h2>
          <div className="form-grid">
            <Field label="First name" htmlFor="pf" hint={nameEditable ? undefined : 'Changed by your manager'}><input id="pf" className="input" value={f.firstName} disabled={!nameEditable} onChange={(e) => setF({ ...f, firstName: e.target.value })} autoComplete="given-name" /></Field>
            <Field label="Last name" htmlFor="pl"><input id="pl" className="input" value={f.lastName} disabled={!nameEditable} onChange={(e) => setF({ ...f, lastName: e.target.value })} autoComplete="family-name" /></Field>
            <Field label="Phone" htmlFor="pp"><input id="pp" className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" /></Field>
            <Field label="Street and number" htmlFor="ps" hint="Only you and administrators can see your address"><input id="ps" className="input" value={f.addressStreet} onChange={(e) => setF({ ...f, addressStreet: e.target.value })} autoComplete="street-address" /></Field>
            <Field label="Postal code" htmlFor="pz"><input id="pz" className="input" value={f.addressPostalCode} onChange={(e) => setF({ ...f, addressPostalCode: e.target.value })} autoComplete="postal-code" /></Field>
            <Field label="City" htmlFor="pc"><input id="pc" className="input" value={f.addressCity} onChange={(e) => setF({ ...f, addressCity: e.target.value })} autoComplete="address-level2" /></Field>
          </div>
          <div className="row end"><Button variant="primary" loading={saveDetails.isPending} onClick={() => saveDetails.mutate()}>Save details</Button></div>
        </section>

        <section className="card stack">
          <h2>Account</h2>
          <dl className="dl">
            <dt>Email</dt>
            <dd className="row wrap">{p.email ?? 'Not set'} {p.email && (p.emailVerified ? <Pill tone="green">Verified</Pill> : <Pill tone="amber">Not verified</Pill>)}</dd>
            <dt>Home branch</dt>
            <dd>{p.memberships.find((m: any) => m.branchId === p.homeBranchId)?.branchName ?? '–'}</dd>
            <dt>Can work at</dt>
            <dd>{eligible.map((m: any) => m.branchName).join(', ') || '–'}</dd>
            <dt>Contract</dt>
            <dd>{p.contractWeeklyMinutes != null ? `${hours(p.contractWeeklyMinutes)} per week` : 'Not set'}</dd>
            {p.workingTimeProfileName && (<><dt>Working-time profile</dt><dd>{p.workingTimeProfileName}</dd></>)}
            <dt>Skills</dt>
            <dd className="row wrap">{p.skills.length ? p.skills.map((s: any) => <SkillTag key={s.skillId} name={s.name} colorIndex={s.colorIndex} boxed />) : 'None yet'}</dd>
          </dl>
          <div className="row wrap">
            <Button size="sm" icon={EnvelopeSimple} onClick={() => setEmailOpen(true)}>Change email</Button>
            <Button size="sm" icon={LockKey} onClick={() => setPwOpen(true)}>Change password</Button>
          </div>
        </section>

        {eligible.length > 0 && (
          <section className="card stack">
            <h2>Working preferences</h2>
            <p className="subtle">Preferences help the scheduler choose between people who are all available. They never replace your availability.</p>
            <span className="label">Preferred shift times</span>
            <div className="stack sm">
              {SHIFTS.map((s) => {
                const v = f.shiftPreferences[s.slot] ?? 0;
                return (
                  <div key={s.slot} className="row wrap between">
                    <span>{shiftTime(s.slot)}</span>
                    <div className="segmented" role="group" aria-label={`Preference for ${shiftTime(s.slot)}`}>
                      {([[1, 'Prefer', ThumbsUp], [0, 'No preference', Minus], [-1, 'Rather not', ThumbsDown]] as const).map(([val, label, I]) => (
                        <button key={val} aria-pressed={v === val} onClick={() => setF({ ...f, shiftPreferences: { ...f.shiftPreferences, [s.slot]: val } })}>
                          <I size={16} /> {label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {eligible.length > 1 && (
              <>
                <span className="label">Preferred branches (1 = most preferred)</span>
                {eligible.map((m: any) => {
                  const rank = f.preferredBranches.find((b: any) => b.branchId === m.branchId)?.rank ?? '';
                  return (
                    <div key={m.branchId} className="row between">
                      <span>{m.branchName}</span>
                      <select className="select sm" style={{ width: 150 }} value={rank} aria-label={`Rank for ${m.branchName}`} onChange={(e) => {
                        const r = e.target.value ? Number(e.target.value) : null;
                        const rest = f.preferredBranches.filter((b: any) => b.branchId !== m.branchId && b.rank !== r);
                        setF({ ...f, preferredBranches: r ? [...rest, { branchId: m.branchId, rank: r }] : rest });
                      }}>
                        <option value="">No preference</option>
                        {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </div>
                  );
                })}
              </>
            )}
            <div className="row end"><Button variant="primary" loading={savePrefs.isPending} onClick={() => savePrefs.mutate()}>Save preferences</Button></div>
          </section>
        )}

        <Sessions />
      </div>

      <EmailModal open={emailOpen} onClose={() => setEmailOpen(false)} current={p.email} />
      <Modal open={pwOpen} onClose={() => setPwOpen(false)} title="Change password" description="All other devices are signed out afterwards.">
        <ChangePasswordForm onDone={(m) => { setMe(m); setPwOpen(false); toast.success('Password changed'); }} />
      </Modal>
    </div>
  );
}

function EmailModal({ open, onClose, current }: { open: boolean; onClose: () => void; current: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState(current ?? '');
  const [pw, setPw] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<{ verificationSent: boolean }>('/api/me/email', { email, currentPassword: pw }),
    onSuccess: (r) => {
      toast.success('Email updated', r.verificationSent ? 'Open the link we sent to confirm it.' : 'Email delivery is not configured, so password reset by email is unavailable.');
      setPw('');
      void qc.invalidateQueries({ queryKey: ['profile'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      onClose();
    },
    onError: (e) => toast.error(e, 'Not changed'),
  });
  return (
    <Modal open={open} onClose={onClose} title="Change email address" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!email || !pw} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="stack">
        <Field label="New email address" htmlFor="ne"><input id="ne" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
        <Field label="Current password" htmlFor="ncp" hint="Required to protect your account"><input id="ncp" className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field>
      </div>
    </Modal>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<any[]>('/api/auth/sessions') });
  const revoke = useMutation({ mutationFn: (id: string) => api.post(`/api/auth/sessions/${id}/revoke`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }), onError: (e) => toast.error(e) });
  const others = useMutation({
    mutationFn: () => api.post<{ revoked: number }>('/api/auth/sessions/revoke-others'),
    onSuccess: (r) => {
      toast.success('Signed out elsewhere', `${r.revoked} other session${r.revoked === 1 ? '' : 's'} ended.`);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e) => toast.error(e),
  });
  const device = (ua: string) => (/(iPhone|Android|Mobile)/i.test(ua) ? 'Phone' : /(iPad|Tablet)/i.test(ua) ? 'Tablet' : 'Computer') + (/(Edg)/.test(ua) ? ' · Edge' : /Chrome/.test(ua) ? ' · Chrome' : /Firefox/.test(ua) ? ' · Firefox' : /Safari/.test(ua) ? ' · Safari' : '');
  return (
    <section className="card stack">
      <div className="row between wrap">
        <h2>Signed-in devices</h2>
        <Button size="sm" icon={SignOut} onClick={() => others.mutate()} loading={others.isPending} disabled={(q.data?.length ?? 0) < 2}>Sign out other devices</Button>
      </div>
      {(q.data ?? []).map((s) => (
        <div key={s.id} className="list-item">
          <DeviceMobile size={22} />
          <div className="grow">
            <strong>{device(s.userAgent ?? '')}</strong> {s.current && <Pill tone="green">This device</Pill>}
            <div className="subtle">Last active {instant(s.lastSeenAt)} · signed in {instant(s.createdAt)}</div>
          </div>
          {!s.current && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>Sign out</Button>}
        </div>
      ))}
    </section>
  );
}
