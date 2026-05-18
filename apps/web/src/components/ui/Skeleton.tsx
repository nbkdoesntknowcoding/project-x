export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={
        'animate-pulse bg-[var(--surface-elevated)] ' +
        'rounded-[var(--radius-md)] ' +
        className
      }
    />
  );
}
