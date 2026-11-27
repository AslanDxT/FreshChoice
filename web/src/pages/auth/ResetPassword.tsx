import { CheckCircle } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, Field } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { AuthCard, PasswordHints, tokenFromHash } from './AuthCard';

export default function ResetPassword() {
  const [token] = useState(tokenFromHash);
  const [pw, setPw] = useState('');
  const [rep, setRep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw !== rep) return setError('The passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/reset-password', { token, newPassword: pw });
      history.replaceState(null, '', '/reset-password');
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reset failed.');
    } finally {
      setBusy(false);
    }
  };
  if (!token) {
    return (
      <AuthCard title="Link incomplete" subtitle="Open the link from your email again, or request a new one.">
        <Link className="btn block" to="/forgot-password">
          Request a new link
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={done ? 'Password changed' : 'Choose a new password'}>
      {done ? (
        <div className="stack lg">
          <div className="banner" role="status">
            <CheckCircle size={22} /> Your password was changed and all other devices were signed out.
          </div>
          <Link className="btn primary block" to="/login">
            Sign in
          </Link>
        </div>
      ) : (
        <form className="stack lg" onSubmit={submit}>
          <Field label="New password" htmlFor="p1" hint={<PasswordHints />}>
            <input id="p1" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
          </Field>
          <Field label="Repeat new password" htmlFor="p2" error={error}>
            <input id="p2" className="input" type="password" autoComplete="new-password" value={rep} onChange={(e) => setRep(e.target.value)} required />
          </Field>
          <Button variant="primary" size="lg" type="submit" loading={busy} disabled={pw.length < 10 || pw !== rep} block>
            Save password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
