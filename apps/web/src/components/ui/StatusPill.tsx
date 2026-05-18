import type { ReactNode } from 'react';

type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const tones: Record<Tone, string> = {
  success: 'bg-[var(--status-success-bg)] text-[var(--status-success)] border-[var(--status-success)]/30',
  warning: 'bg-[var(--status-warning-bg)] text-[var(--status-warning)] border-[var(--status-warning)]/30',
  error:   'bg-[var(--status-error-bg)] text-[var(--status-error)] border-[var(--status-error)]/30',
  info:    'bg-[var(--status-info-bg)] text-[var(--status-info)] border-[var(--status-info)]/30',
  neutral: 'bg-[var(--surface-sunken)] text-[var(--text-tertiary)] border-[var(--border-default)]',
};

export function StatusPill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 px-2 h-5 ' +
        'text-[11px] font-medium ' +
        'rounded-[var(--radius-full)] border ' +
        tones[tone]
      }
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
