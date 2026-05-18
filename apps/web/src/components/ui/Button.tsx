import { forwardRef, type ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'secondary', size = 'md', className = '', ...props },
  ref,
) {
  const base =
    'inline-flex items-center justify-center font-medium ' +
    'transition-[background,border-color,color] outline-none ' +
    'focus-visible:[box-shadow:var(--focus-ring)] ' +
    'disabled:opacity-50 disabled:cursor-not-allowed select-none';

  const sizes: Record<Size, string> = {
    sm: 'h-7 px-2.5 text-[12px] gap-1.5 rounded-[var(--radius-sm)]',
    md: 'h-8 px-3 text-[13px] gap-1.5 rounded-[var(--radius-md)]',
    lg: 'h-10 px-4 text-[14px] gap-2 rounded-[var(--radius-md)]',
  };

  const variants: Record<Variant, string> = {
    primary:
      'bg-[var(--interactive-primary)] text-[var(--interactive-primary-fg)] ' +
      'hover:bg-[var(--interactive-primary-hover)] ' +
      'border border-[var(--interactive-primary)]',
    secondary:
      'bg-[var(--interactive-secondary)] text-[var(--text-primary)] ' +
      'hover:bg-[var(--interactive-secondary-hover)] ' +
      'border border-[var(--border-default)]',
    ghost:
      'bg-transparent text-[var(--text-secondary)] ' +
      'hover:bg-[var(--interactive-ghost-hover)] hover:text-[var(--text-primary)] ' +
      'border border-transparent',
    danger:
      'bg-transparent text-[var(--status-error)] ' +
      'hover:bg-[var(--status-error-bg)] ' +
      'border border-transparent',
  };

  return (
    <button
      ref={ref}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    />
  );
});
