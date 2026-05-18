import type { HTMLAttributes } from 'react';

export function DisplayHeading({ children, className = '', ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={
        'text-[56px] leading-[1.15] tracking-[-0.02em] ' +
        'font-semibold text-[var(--text-primary)] ' +
        className
      }
      {...props}
    >
      {children}
    </h1>
  );
}

export function PageHeading({ children, className = '', ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={
        'text-[28px] leading-[1.3] tracking-[-0.01em] ' +
        'font-medium text-[var(--text-primary)] ' +
        className
      }
      {...props}
    >
      {children}
    </h1>
  );
}

export function SectionHeading({ children, className = '', ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={
        'text-[18px] leading-[1.3] ' +
        'font-medium text-[var(--text-primary)] ' +
        className
      }
      {...props}
    >
      {children}
    </h2>
  );
}

export function MetaText({ children, className = '', ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={
        'text-[12px] leading-[1.4] ' +
        'text-[var(--text-tertiary)] ' +
        className
      }
      {...props}
    >
      {children}
    </p>
  );
}

export function MonoLabel({ children, className = '', ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={
        'font-mono text-[11px] uppercase tracking-[0.08em] ' +
        'text-[var(--text-tertiary)] ' +
        className
      }
      {...props}
    >
      {children}
    </span>
  );
}
