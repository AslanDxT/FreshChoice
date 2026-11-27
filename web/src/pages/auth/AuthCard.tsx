import type { ReactNode } from 'react';
import { BrandSymbol, BrandWordmark } from '../../components/BrandMark';

export function AuthCard({ title, subtitle, children, wide }: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <main className="auth-wrap" id="main">
      <div className={`auth-card ${wide ? 'wide' : ''}`}>
        <div className="auth-logo">
          <BrandSymbol size={48} />
          <div>
            <BrandWordmark height={16} />
            <small>Staff scheduling</small>
          </div>
        </div>
        <h1 style={{ fontSize: 24 }}>{title}</h1>
        {subtitle && <p className="muted" style={{ marginTop: 6 }}>{subtitle}</p>}
        <div style={{ marginTop: 22 }}>{children}</div>
      </div>
    </main>
  );
}

/** Reads `token` from the URL fragment (#token=...), which is never sent to the server in logs or Referer headers. */
export function tokenFromHash(): string {
  const h = new URLSearchParams(window.location.hash.slice(1));
  return h.get('token') ?? '';
}

export function PasswordHints() {
  return (
    <ul className="subtle" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
      <li>At least 10 characters; a short sentence works well.</li>
      <li>Not your employee number, email address or a common password.</li>
    </ul>
  );
}
