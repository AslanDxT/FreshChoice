import { Eye, EyeSlash, SignIn } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { Button, Field } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { useAuth, type Me } from '../../lib/auth';
import { AuthCard } from './AuthCard';

export default function Login() {
  const { me, setMe } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const m = await api.post<Me>('/api/auth/login', { identifier, password });
      setMe(m);
      const from = (loc.state as any)?.from;
      nav(m.user.mustChangePassword ? '/change-password' : from && from !== '/login' ? from : '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in" subtitle="Use your employee number (or email) and password.">
      <form className="stack lg" onSubmit={submit} noValidate>
        <Field label="Employee number or email" htmlFor="id">
          <input id="id" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus />
        </Field>
        <Field label="Password" htmlFor="pw" error={error}>
          <div style={{ position: 'relative' }}>
            <input id="pw" className="input" type={show ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} style={{ paddingRight: 48 }} />
            <button type="button" className="icon-btn sm" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} style={{ position: 'absolute', right: 6, top: 6 }}>
              {show ? <EyeSlash size={20} /> : <Eye size={20} />}
            </button>
          </div>
        </Field>
        <Button variant="primary" size="lg" icon={SignIn} loading={busy} type="submit" block disabled={!identifier || !password}>
          Sign in
        </Button>
        <p className="muted" style={{ textAlign: 'center' }}>
          <Link to="/forgot-password">Forgot your password?</Link>
        </p>
        <p className="subtle" style={{ textAlign: 'center' }}>
          First time here? Sign in with the temporary password from your manager. You will choose your own password straight away.
        </p>
      </form>
    </AuthCard>
  );
}
