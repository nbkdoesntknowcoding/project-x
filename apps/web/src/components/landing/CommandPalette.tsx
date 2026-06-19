'use client';
/**
 * CommandPalette — a faithful Mnema translation of Raycast's floating command
 * palette (search row → results list → action bar). Here it shows an MCP agent
 * "reading context" from the workspace: it types a tool call, then the source
 * rows light up one-by-one ("reading"), then a one-line answer streams in.
 *
 * Pure state machine + timers; no animation lib. Respects prefers-reduced-motion
 * (renders the settled state). Amber = primary accent, indigo = MCP/agent accent.
 */
import { useEffect, useRef, useState } from 'react';

const AMBER = '#FFB370';
const INDIGO = '#7C9CFF';
const GREEN = '#6BE39B';

interface Source {
  title: string;
  kind: string;
  color: string;
}

const COMMAND = 'get_flow("onboarding")';
const SOURCES: Source[] = [
  { title: 'Architecture', kind: 'doc', color: INDIGO },
  { title: 'MCP read path', kind: 'doc', color: INDIGO },
  { title: 'Pricing', kind: 'doc', color: INDIGO },
  { title: 'Onboarding flow', kind: 'flow', color: AMBER },
];
const ANSWER = 'Returned 4 sources · 182ms — flow steps in order, your instructions between each.';

type Phase = 'typing' | 'reading' | 'answering' | 'hold';

export default function CommandPalette() {
  const [typed, setTyped] = useState('');
  const [readCount, setReadCount] = useState(0); // sources that have been "read"
  const [activeRow, setActiveRow] = useState(-1);
  const [answer, setAnswer] = useState('');
  const [phase, setPhase] = useState<Phase>('typing');
  const cancelled = useRef(false);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setTyped(COMMAND);
      setReadCount(SOURCES.length);
      setActiveRow(-1);
      setAnswer(ANSWER);
      setPhase('hold');
      return;
    }
    cancelled.current = false;
    const run = async () => {
      while (!cancelled.current) {
        // reset
        setPhase('typing');
        setTyped('');
        setReadCount(0);
        setActiveRow(-1);
        setAnswer('');
        await typeInto(COMMAND, setTyped, 55);
        if (cancelled.current) return;
        // read sources one-by-one
        setPhase('reading');
        for (let i = 0; i < SOURCES.length; i++) {
          if (cancelled.current) return;
          setActiveRow(i);
          await wait(480);
          setReadCount(i + 1);
        }
        setActiveRow(-1);
        if (cancelled.current) return;
        // stream answer
        setPhase('answering');
        await wait(220);
        await typeInto(ANSWER, setAnswer, 14);
        if (cancelled.current) return;
        setPhase('hold');
        await wait(3400);
      }
    };
    run();
    return () => {
      cancelled.current = true;
    };
  }, []);

  return (
    <div
      role="img"
      aria-label="Mnema MCP command palette reading workspace context"
      style={{
        width: '100%',
        background: 'rgba(12,13,16,0.86)',
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '14px',
        boxShadow:
          '0 1px 0 rgba(255,255,255,0.06) inset, 0 40px 90px -30px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.03)',
        overflow: 'hidden',
        fontFamily: 'var(--sans)',
      }}
    >
      {/* search row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '13px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: AMBER }}>mcp&nbsp;›</span>
        <span
          style={{
            flex: 1,
            fontFamily: 'var(--mono)',
            fontSize: '13px',
            color: '#F4F5F7',
            letterSpacing: '-0.01em',
          }}
        >
          {typed}
          {phase === 'typing' && <Caret />}
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: '10px',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: INDIGO,
            border: `1px solid ${hexA(INDIGO, 0.32)}`,
            background: hexA(INDIGO, 0.08),
            borderRadius: '5px',
            padding: '3px 6px',
          }}
        >
          Tab · Ask
        </span>
      </div>

      {/* section label */}
      <div
        style={{
          padding: '10px 14px 6px',
          fontFamily: 'var(--mono)',
          fontSize: '10px',
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>Reading from workspace</span>
        <span style={{ color: phase === 'reading' ? AMBER : 'var(--text-tertiary)' }}>
          {readCount}/{SOURCES.length}
        </span>
      </div>

      {/* source rows */}
      <div style={{ padding: '0 6px 6px' }}>
        {SOURCES.map((s, i) => {
          const isActive = activeRow === i;
          const isRead = i < readCount;
          return (
            <div
              key={s.title}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '8px 8px',
                borderRadius: '8px',
                background: isActive ? hexA(AMBER, 0.1) : 'transparent',
                transition: 'background 180ms',
              }}
            >
              <span
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '5px',
                  background: hexA(s.color, 0.16),
                  border: `1px solid ${hexA(s.color, 0.4)}`,
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <span style={{ width: '6px', height: '6px', borderRadius: '2px', background: s.color }} />
              </span>
              <span style={{ fontSize: '13px', color: '#F4F5F7', flex: 1 }}>{s.title}</span>
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--text-tertiary)',
                }}
              >
                {s.kind}
              </span>
              <span
                style={{
                  width: '52px',
                  textAlign: 'right',
                  fontFamily: 'var(--mono)',
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: isRead ? GREEN : isActive ? AMBER : 'var(--text-quaternary)',
                }}
              >
                {isRead ? '✓ read' : isActive ? 'reading' : 'queued'}
              </span>
            </div>
          );
        })}
      </div>

      {/* streamed answer */}
      <div
        style={{
          padding: '4px 14px 0',
          minHeight: '34px',
          fontSize: '12px',
          lineHeight: 1.5,
          color: 'var(--text-secondary)',
        }}
      >
        {answer}
        {phase === 'answering' && <Caret />}
      </div>

      {/* action bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '9px 14px',
          marginTop: '6px',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '7px',
            fontFamily: 'var(--mono)',
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: 'var(--text-tertiary)',
          }}
        >
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: GREEN, boxShadow: `0 0 8px ${hexA(GREEN, 0.6)}` }} />
          Claude · connected
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '14px',
            fontFamily: 'var(--mono)',
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: 'var(--text-tertiary)',
          }}
        >
          <span>Return context&nbsp;<Key>↵</Key></span>
          <span>Sources&nbsp;<Key>⌘K</Key></span>
        </span>
      </div>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 5px',
        marginLeft: '2px',
        borderRadius: '4px',
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.10)',
        color: 'var(--text-secondary)',
      }}
    >
      {children}
    </span>
  );
}

function Caret() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: '2px',
        height: '1em',
        marginLeft: '2px',
        verticalAlign: 'text-bottom',
        background: AMBER,
        animation: 'mnemaBlink 1s steps(2) infinite',
      }}
    />
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function typeInto(text: string, setter: (s: string) => void, perChar: number): Promise<void> {
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      i += 1;
      setter(text.slice(0, i));
      if (i >= text.length) return resolve();
      setTimeout(step, perChar + (Math.random() * perChar) / 2);
    };
    step();
  });
}

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}
