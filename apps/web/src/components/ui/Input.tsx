import { forwardRef, type InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { invalid, className = '', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={
        'w-full h-9 px-3 text-[14px] ' +
        'bg-[var(--surface-sunken)] ' +
        'border ' +
        (invalid
          ? 'border-[var(--status-error)] '
          : 'border-[var(--border-default)] hover:border-[var(--border-strong)] ') +
        'rounded-[var(--radius-md)] ' +
        'text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] ' +
        'outline-none transition-[border-color] ' +
        'focus:border-[var(--border-focus)] focus:[box-shadow:var(--focus-ring)] ' +
        'disabled:opacity-50 disabled:cursor-not-allowed ' +
        className
      }
      {...props}
    />
  );
});
