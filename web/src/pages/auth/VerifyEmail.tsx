import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { SquareMorph } from '../../components/ui';
import { ApiError, api } from '../../lib/api';
import { AuthCard, tokenFromHash } from './AuthCard';

export default function VerifyEmail() {
  const [state, setState] = useState<'busy' | 'ok' | 'error'>('busy');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const token = tokenFromHash();
    if (!token) {
      setState('error');
      setMsg('This link is incomplete.');
      return;
    }
    api
      .post('/api/auth/verify-email', { token })
      .then(() => {
        history.replaceState(null, '', '/verify-email');
        setState('ok');
      })
      .catch((e) => {
        setState('error');
        setMsg(e instanceof ApiError ? e.message : 'Verification failed.');
      });
  }, []);
  return (
    <AuthCard title="Email verification">
      {state === 'busy' && <SquareMorph label="Checking your link" />}
      {state === 'ok' && (
        <div className="stack lg">
          <div className="banner" role="status">
            <CheckCircle size={22} /> Your email address is confirmed. It can now be used for password resets.
          </div>
          <Link to="/" className="btn primary block">
            Continue
          </Link>
        </div>
      )}
      {state === 'error' && (
        <div className="stack lg">
          <div className="banner error" role="alert">
            <WarningCircle size={22} /> {msg}
          </div>
          <Link to="/" className="btn block">
            Continue
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
