import { LockKey } from '@phosphor-icons/react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Field, useToast } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useAuth, useMe, type Me } from '../../lib/auth';
import { AuthCard, PasswordHints } from './AuthCard';

export function ChangePasswordForm({ onDone, submitLabel = 'Save new password' }: { onDone: (m: Me) => void; submitLabel?: string }) {
  const me = useMe();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = repeat.length > 0 && next !== repeat;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== repeat) return setError('The new passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      const m = await api.post<Me>('/api/auth/change-password', { currentPassword: current, newPassword: next });
      onDone(m);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack lg" onSubmit={submit}>
      <input type="text" autoComplete="username" value={me.user.employeeNumber} readOnly hidden />
      <Field label={me.user.mustChangePassword ? 'Temporary password' : 'Current password'} htmlFor="cur">
        <input id="cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="New password" htmlFor="new" hint={<PasswordHints />}>
        <input id="new" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />
      </Field>
      <Field label="Repeat new password" htmlFor="rep" error={mismatch ? 'The passwords do not match.' : error}>
        <input id="rep" className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required aria-invalid={mismatch} />
      </Field>
      <Button variant="primary" size="lg" icon={LockKey} type="submit" loading={busy} disabled={!current || next.length < 10 || next !== repeat}>
        {submitLabel}
      </Button>
    </form>
  );
}

export default function ChangePassword() {
  const me = useMe();
  const { setMe, logout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  return (
    <AuthCard
      title={me.user.mustChangePassword ? 'Choose your own password' : 'Change password'}
      subtitle={me.user.mustChangePassword ? `Welcome, ${me.user.firstName}. Your temporary password stops working once you set your own.` : undefined}
    >
      <ChangePasswordForm
        onDone={(m) => {
          setMe(m);
          toast.success('Password saved', 'You are now signed in with your new password.');
          nav('/', { replace: true });
        }}
      />
      <p style={{ textAlign: 'center', marginTop: 16 }}>
        <button className="btn ghost sm" onClick={() => void logout().then(() => nav('/login'))}>
          Sign out instead
        </button>
      </p>
    </AuthCard>
  );
}
