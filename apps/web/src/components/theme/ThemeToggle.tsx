import { type JSX, useEffect, useState } from 'react';

type Choice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'mnema:theme';

interface Props {
  /** Optional visual variant: "compact" (default) for headers, "full" for
   *  settings pages where the toggle has more room. */
  size?: 'compact' | 'full';
}

/**
 * Three-state theme toggle: system / light / dark.
 *
 * The data-theme attribute on <html> is the single switching mechanism;
 * we set it here on every click and the no-FOUC inline script in
 * BaseLayout.astro sets it on initial page load. localStorage persists
 * the user's explicit choice; "system" clears the key so future page
 * loads re-derive from prefers-color-scheme.
 *
 * When the choice is "system" we subscribe to the OS preference so a
 * mid-session OS theme change reflects immediately. When it's an
 * explicit choice the subscription is unnecessary.
 */
export function ThemeToggle({ size = 'compact' }: Props): JSX.Element {
  const [choice, setChoice] = useState<Choice>('system');

  // Hydrate from localStorage on mount. The inline script in BaseLayout
  // already applied the right theme before paint — we just need to know
  // which radio to mark as selected.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Choice | null;
      if (stored === 'light' || stored === 'dark') {
        setChoice(stored);
      } else {
        setChoice('system');
      }
    } catch {
      /* private-mode browsers throw — fall back to default state */
    }
  }, []);

  function apply(c: Choice): void {
    setChoice(c);
    try {
      if (c === 'system') {
        localStorage.removeItem(STORAGE_KEY);
        const sysLight = window.matchMedia('(prefers-color-scheme: light)').matches;
        document.documentElement.setAttribute('data-theme', sysLight ? 'light' : 'dark');
      } else {
        localStorage.setItem(STORAGE_KEY, c);
        document.documentElement.setAttribute('data-theme', c);
      }
    } catch {
      /* private-mode browsers throw on localStorage write; we still apply
       * the data-theme so the page recolors for this session even if it
       * doesn't persist. */
      document.documentElement.setAttribute(
        'data-theme',
        c === 'system' ? 'dark' : c,
      );
    }
  }

  // Keep tracking OS preference while the user is on "system".
  useEffect(() => {
    if (choice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    function handler(e: MediaQueryListEvent): void {
      document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
    }
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [choice]);

  const pad = size === 'full' ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-1 text-xs';

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex rounded-md p-0.5"
      style={{ border: '1px solid var(--border-default)', background: 'var(--surface-base)' }}
    >
      {(['system', 'light', 'dark'] as Choice[]).map((c) => {
        const selected = choice === c;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => apply(c)}
            className={`${pad} rounded transition-colors`}
            style={{
              background: selected ? 'var(--surface-overlay)' : 'transparent',
              color: selected ? 'var(--text-primary)' : 'var(--text-tertiary)',
            }}
          >
            {c[0]!.toUpperCase() + c.slice(1)}
          </button>
        );
      })}
    </div>
  );
}
