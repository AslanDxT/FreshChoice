import {
  CheckCircle,
  Info,
  WarningCircle,
  X,
  XCircle,
  type Icon,
} from '@phosphor-icons/react';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../lib/api';
import { BrandSymbol, BrandWordmark } from './BrandMark';

/* ---------------------------------------------------------------- Loader */
export function SquareMorph({ label = 'Loading', size = 30, hideLabel = false }: { label?: string; size?: number; hideLabel?: boolean }) {
  return (
    <div className="square-morph" role="status" aria-live="polite" style={{ ['--size' as any]: `${size}px` }}>
      <div className="sq" aria-hidden="true" />
      <span className={hideLabel ? 'sr-only' : undefined}>{label}</span>
    </div>
  );
}

export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading-center">
      <SquareMorph label={label} />
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%', radius }: { height?: number; width?: number | string; radius?: number }) {
  return <div className="skeleton" style={{ height, width, borderRadius: radius }} aria-hidden="true" />;
}

/* ---------------------------------------------------------------- Button */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'accent' | 'ghost' | 'danger' | 'default';
  size?: 'sm' | 'md' | 'lg';
  icon?: Icon;
  loading?: boolean;
  block?: boolean;
};

export function Button({ variant = 'default', size = 'md', icon: Ico, loading, block, children, className = '', disabled, ...rest }: BtnProps) {
  const cls = ['btn', variant !== 'default' && variant, size !== 'md' && size, block && 'block', className].filter(Boolean).join(' ');
  return (
    <button className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="square-morph" aria-hidden="true" style={{ ['--size' as any]: '14px' }}><span className="sq" /></span> : Ico ? <Ico size={size === 'sm' ? 16 : 19} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon: Ico, label, badge, size = 'md', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: Icon; label: string; badge?: number; size?: 'sm' | 'md' }) {
  return (
    <button className={`icon-btn ${size === 'sm' ? 'sm' : ''}`} aria-label={label} title={label} {...rest}>
      <Ico size={size === 'sm' ? 18 : 22} />
      {badge ? <span className="dot">{badge > 99 ? '99+' : badge}</span> : null}
    </button>
  );
}

/* ----------------------------------------------------------- Empty state */
export function EmptyState({ icon: Ico, title, children, action }: { icon: Icon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="halo">
        <Ico size={30} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : 'Something went wrong while loading.';
  return (
    <div className="banner error" role="alert">
      <WarningCircle size={22} />
      <span className="grow">{msg}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Pill */
export type Tone = 'coral' | 'teal' | 'blue' | 'red' | 'green' | 'yellow' | 'purple' | 'amber' | 'neutral';
export function Pill({ tone = 'neutral', icon: Ico, children, title }: { tone?: Tone; icon?: Icon; children: ReactNode; title?: string }) {
  return (
    <span className={`pill ${tone === 'neutral' ? '' : tone}`} title={title}>
      {Ico && <Ico size={14} weight="bold" />}
      {children}
    </span>
  );
}

export function SkillTag({ name, colorIndex, boxed }: { name: string; colorIndex?: number | null; boxed?: boolean }) {
  return (
    <span className={`skill ${boxed ? 'boxed' : ''}`} style={{ ['--skill-color' as any]: colorIndex != null ? `var(--skill-${colorIndex})` : undefined }}>
      {name}
    </span>
  );
}

export function Avatar({ name, userId, hasPhoto, size = 36 }: { name: string; userId?: string; hasPhoto?: boolean; size?: number }) {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  return (
    <span className="avatar" style={{ ['--av' as any]: `${size}px` }} aria-hidden="true">
      {hasPhoto && userId ? <img src={`/api/users/${userId}/photo`} alt="" loading="lazy" /> : initials}
    </span>
  );
}

/* ----------------------------------------------------------- Modal/Drawer */
function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(node?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter((el) => !el.hasAttribute('disabled'));
    const first = node?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open, onClose]);
  return ref;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useFocusTrap(open, onClose);
  const id = useId();
  if (!open) return null;
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} ref={ref}>
        <div className="modal-head">
          <div className="stack sm">
            <h2 id={`${id}-t`}>{title}</h2>
            {description && <div className="muted">{description}</div>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} size="sm" />
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  const ref = useFocusTrap(open, onClose);
  const id = useId();
  if (!open) return null;
  return createPortal(
    <div className="scrim drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} ref={ref}>
        <div className="modal-head">
          <h2 id={`${id}-t`}>{title}</h2>
          <IconButton icon={X} label="Close" onClick={onClose} size="sm" />
        </div>
        {children}
      </aside>
    </div>,
    document.body,
  );
}

export function Confirm({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = 'Confirm',
  danger,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} data-autofocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

/* ----------------------------------------------------------------- Field */
export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && (
        <div className="error" role="alert">
          <WarningCircle size={15} /> {error}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: Icon }[]; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} title={o.label}>
          {o.icon && <o.icon size={17} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; icon?: Icon }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}>
          {t.icon && <t.icon size={18} />}
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Toasts */
type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}
const ToastContext = createContext<(kind: ToastKind, title: string, body?: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((kind: ToastKind, title: string, body?: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, kind, title, body }]);
    window.setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 9000 : 5500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => {
          const Ico = t.kind === 'success' ? CheckCircle : t.kind === 'error' ? XCircle : Info;
          return (
            <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
              <Ico size={22} weight="regular" style={{ color: t.kind === 'success' ? 'var(--green)' : t.kind === 'error' ? 'var(--red)' : 'var(--accent-ink)', flex: 'none' }} />
              <div className="grow">
                <strong>{t.title}</strong>
                {t.body && <p className="muted" style={{ fontSize: 14, marginTop: 2 }}>{t.body}</p>}
              </div>
              <IconButton icon={X} label="Dismiss" size="sm" onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))} />
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  return {
    success: (title: string, body?: string) => push('success', title, body),
    info: (title: string, body?: string) => push('info', title, body),
    error: (e: unknown, fallback = 'Something went wrong') => push('error', e instanceof ApiError ? (e.code === 'NETWORK' ? 'Not saved' : fallback) : fallback, e instanceof ApiError ? e.message : undefined),
  };
}

export function Logo({ size = 34, withText = true, subtitle }: { size?: number; withText?: boolean; subtitle?: string }) {
  return (
    <>
      <BrandSymbol size={size} label={withText ? undefined : 'Fresh Choice'} />
      {withText && (
        <span>
          <BrandWordmark height={13} />
          {subtitle && <small>{subtitle}</small>}
        </span>
      )}
    </>
  );
}
