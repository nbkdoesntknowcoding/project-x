'use client';
/**
 * LiveStats — dub.co-style animated counters that roll from 0 when scrolled into
 * view, plus a small "live event" ticker. Numbers are illustrative (not real
 * telemetry). Light: useCountUp + useInView, no canvas.
 */
import { useEffect, useState } from 'react';
import { useCountUp } from '../../lib/hooks/useCountUp';
import { useInView } from '../../lib/hooks/useInView';

interface Stat {
  label: string;
  target: number;
  suffix?: string;
  format?: (n: number) => string;
}

const STATS: Stat[] = [
  { label: 'Docs indexed', target: 48213, format: groupThousands },
  { label: 'Flows mapped', target: 1947, format: groupThousands },
  { label: 'Graph connections', target: 312068, format: groupThousands },
];

const EVENTS = [
  'doc updated · Architecture',
  'flow published · Onboarding',
  'meeting captured · 3 decisions',
  'node linked · Voice Clone ↔ Streaming STT',
  'agent read · get_flow("onboarding")',
  'task moved · Latest build → review',
];

function groupThousands(n: number): string {
  return n.toLocaleString('en-US');
}

function StatCard({ stat, active }: { stat: Stat; active: boolean }) {
  const value = useCountUp(stat.target, active);
  const text = stat.format ? stat.format(value) : String(value);
  return (
    <div
      className="flex flex-col items-center text-center px-4"
      style={{ flex: 1 }}
    >
      <div
        className="font-sans"
        style={{
          fontSize: 'clamp(36px, 5vw, 56px)',
          fontWeight: 500,
          letterSpacing: '-0.02em',
          color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.05,
        }}
      >
        {text}
        {stat.suffix ?? ''}
      </div>
      <div
        className="font-mono uppercase mt-3"
        style={{ fontSize: '11px', letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}
      >
        {stat.label}
      </div>
    </div>
  );
}

function EventTicker() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % EVENTS.length), 2200);
    return () => clearInterval(id);
  }, []);
  return (
    <div
      className="inline-flex items-center gap-2.5 mx-auto mt-12 px-3.5 py-2 font-mono"
      style={{
        fontSize: '12px',
        color: 'var(--text-secondary)',
        background: 'var(--surface-overlay)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-full)',
      }}
    >
      <span
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          background: 'var(--status-sync)',
          boxShadow: '0 0 8px rgba(107,227,155,0.6)',
          flexShrink: 0,
        }}
      />
      <span style={{ minWidth: '260px', textAlign: 'left' }} key={idx}>
        {EVENTS[idx]}
      </span>
    </div>
  );
}

export default function LiveStats() {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.4 });
  return (
    <div ref={ref} className="flex flex-col items-center">
      <div className="flex w-full max-w-3xl items-stretch justify-between gap-2">
        {STATS.map((s) => (
          <StatCard key={s.label} stat={s} active={inView} />
        ))}
      </div>
      <EventTicker />
    </div>
  );
}
