import type { ReactNode } from 'react';

interface Props {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="text-[var(--text-tertiary)] mb-4">
        {icon ?? (
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" />
          </svg>
        )}
      </div>
      <p className="text-[var(--text-primary)] text-[14px] font-medium mb-1">{title}</p>
      {description && (
        <p className="text-[var(--text-tertiary)] text-[13px] max-w-sm mb-6">{description}</p>
      )}
      {action}
    </div>
  );
}
