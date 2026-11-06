import type { Check } from '../lib/verify';

/** A list of verification results. Each row says what was checked and, on failure, why. */
export function Checks({ checks, compact = false }: { checks: Check[]; compact?: boolean }) {
  if (compact) {
    const failed = checks.filter((check) => !check.ok);
    return (
      <span className={`badge ${failed.length ? 'badge-bad' : 'badge-good'}`} title={checks.map((c) => `${c.ok ? '✓' : '✕'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`).join('\n')}>
        <span aria-hidden="true">{failed.length ? '✕' : '✓'}</span> {failed.length ? `${failed.length} check${failed.length > 1 ? 's' : ''} failed` : 'verified'}
      </span>
    );
  }
  return (
    <ul className="checks">
      {checks.map((check) => (
        <li key={check.label} className={check.ok ? 'check-ok' : 'check-bad'}>
          <span className="check-mark" aria-hidden="true">
            {check.ok ? '✓' : '✕'}
          </span>
          <span>
            {check.label}
            {check.detail ? <span className="check-detail"> — {check.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A value with a link to the block explorer when one is configured. */
export function Linked({ href, children }: { href?: string | undefined; children: React.ReactNode }) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}
