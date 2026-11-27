import { EnvelopeSimple } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button, Field } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { AuthCard } from './AuthCard';

export default function ForgotPassword() {
  const [identifier, setIdentifier] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string }>('/api/auth/forgot-password', { identifier });
      setMessage(r.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title="Reset your password" subtitle="Enter your employee number or email address.">
      {message ? (
        <div className="stack lg">
          <div className="banner info" role="status">
            <EnvelopeSimple size={22} />
            <span>{message}</span>
          </div>
          <Link to="/login" className="btn block">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form className="stack lg" onSubmit={submit}>
          <Field label="Employee number or email" htmlFor="id" error={error}>
            <input id="id" className="input" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required autoFocus />
          </Field>
          <Button variant="primary" size="lg" type="submit" loading={busy} disabled={!identifier} block>
            Send reset link
          </Button>
          <p className="muted" style={{ textAlign: 'center' }}>
            <Link to="/login">Back to sign in</Link>
          </p>
        </form>
      )}
    </AuthCard>
  );
}
