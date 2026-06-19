'use client';
/**
 * FeatureCards — a faithful Mnema translation of Raycast's "There's an extension
 * for that" section: a tab/pill switcher that swaps a grid of feature cards, each
 * with its OWN bespoke inner mockup. Accent-tinted glow per card. Amber primary,
 * indigo contrast; entity colours reused for the graph/flow mocks.
 */
import { useState } from 'react';

type MockKind =
  | 'transcript'
  | 'editor'
  | 'recall'
  | 'flow'
  | 'doclist'
  | 'instruction'
  | 'code'
  | 'graph'
  | 'agent';

interface Card {
  title: string;
  desc: string;
  accent: string;
  mock: MockKind;
}

interface Tab {
  key: string;
  label: string;
  cards: Card[];
}

const INDIGO = '#7C9CFF';
const AMBER = '#FFB370';
const GREEN = '#6BE39B';
const BLUE = '#60a5fa';
const PURPLE = '#a78bfa';
const PINK = '#e879f9';

const TABS: Tab[] = [
  {
    key: 'capture',
    label: 'Capture',
    cards: [
      { title: 'Meeting assistant', accent: INDIGO, mock: 'transcript', desc: 'A bot joins your calls, transcribes live, and answers from your workspace out loud.' },
      { title: 'Live editing', accent: BLUE, mock: 'editor', desc: 'Edit a doc and every flow and agent reading it updates within milliseconds.' },
      { title: 'Recall integration', accent: PINK, mock: 'recall', desc: 'Drop Mnema into Meet, Zoom, or Teams — it captures decisions as structured notes.' },
    ],
  },
  {
    key: 'compose',
    label: 'Compose',
    cards: [
      { title: 'Flows', accent: AMBER, mock: 'flow', desc: 'Sequence docs and instructions into steps your AI reads in order, not all at once.' },
      { title: 'Doc library', accent: BLUE, mock: 'doclist', desc: 'Every doc is addressable. One source of truth, composed into many flows.' },
      { title: 'Instructions', accent: GREEN, mock: 'instruction', desc: 'Annotate each step in your own words — Claude reads the instruction before the doc.' },
    ],
  },
  {
    key: 'connect',
    label: 'Connect',
    cards: [
      { title: 'Native to MCP', accent: GREEN, mock: 'code', desc: 'Flows and docs expose as MCP tools. Claude, Cursor, or any agent calls them directly.' },
      { title: 'Knowledge graph', accent: PURPLE, mock: 'graph', desc: 'Auto-built connections across docs, projects, and tasks — traversable by agents.' },
      { title: 'Project-scoped agents', accent: INDIGO, mock: 'agent', desc: 'Bind an agent to a project; it answers only from what that project can see.' },
    ],
  },
];

export default function FeatureCards() {
  const [active, setActive] = useState(0);
  const tab = TABS[active]!;
  return (
    <div>
      {/* heading + tab switcher (Raycast layout) */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-10">
        <div className="max-w-md">
          <h2
            className="font-sans font-medium"
            style={{ fontSize: '32px', lineHeight: 1.12, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}
          >
            There's a surface for that.
          </h2>
          <p
            className="mt-3"
            style={{ fontSize: '16px', lineHeight: 1.5, color: 'var(--text-tertiary)' }}
          >
            Use your knowledge everywhere your team and your agents already work.
          </p>
        </div>
        {/* pill switcher */}
        <div
          className="inline-flex p-1 self-start md:self-auto"
          style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-full)' }}
        >
          {TABS.map((t, i) => (
            <button
              key={t.key}
              onClick={() => setActive(i)}
              className="relative px-4 h-8 font-medium select-none transition-colors"
              style={{
                fontSize: '13px',
                color: i === active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                background: i === active ? 'var(--surface-elevated)' : 'transparent',
                border: i === active ? '1px solid var(--border-default)' : '1px solid transparent',
                borderRadius: 'var(--radius-full)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* cards — re-keyed per tab so the CSS fade replays on switch */}
      <div key={tab.key} className="grid gap-5 md:grid-cols-3">
        {tab.cards.map((card, i) => (
          <div
            key={card.title}
            className="mnema-reveal"
            style={{ animation: 'mnemaFadeUp 0.42s cubic-bezier(0.16,1,0.3,1) both', animationDelay: `${i * 70}ms` }}
          >
            <FeatureCard card={card} />
          </div>
        ))}
      </div>
    </div>
  );
}

function FeatureCard({ card }: { card: Card }) {
  return (
    <div
      className="group relative overflow-hidden h-full flex flex-col transition-colors"
      style={{
        background: `radial-gradient(ellipse 130% 64% at 50% 122%, ${hexA(card.accent, 0.18)}, transparent 60%), var(--surface-overlay)`,
        border: '1px solid var(--border-subtle)',
        borderRadius: '18px',
        minHeight: '436px',
      }}
    >
      {/* header */}
      <div className="flex items-start gap-3.5 px-6 pt-6 pb-3">
        <span
          className="inline-flex items-center justify-center flex-shrink-0"
          style={{ width: '40px', height: '40px', borderRadius: '11px', background: hexA(card.accent, 0.14), border: `1px solid ${hexA(card.accent, 0.36)}`, color: card.accent, boxShadow: `0 6px 18px -8px ${hexA(card.accent, 0.5)}` }}
        >
          <CardIcon kind={card.mock} />
        </span>
        <h3 className="flex-1" style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', paddingTop: '9px', letterSpacing: '-0.01em' }}>{card.title}</h3>
        <span
          className="inline-flex items-center justify-center flex-shrink-0 transition-colors"
          style={{ width: '30px', height: '30px', borderRadius: '50%', background: 'var(--surface-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
        </span>
      </div>
      <p className="px-6 pb-5" style={{ fontSize: '14px', lineHeight: 1.55, color: 'var(--text-secondary)', maxWidth: '94%' }}>{card.desc}</p>

      {/* bespoke inner mockup, bleeding to the bottom edge */}
      <div className="mt-auto relative" style={{ height: '224px' }}>
        <Mock kind={card.mock} accent={card.accent} />
      </div>
    </div>
  );
}

function CardIcon({ kind }: { kind: MockKind }) {
  const p = (d: string) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {d.split('|').map((seg, i) => <path key={i} d={seg} />)}
    </svg>
  );
  switch (kind) {
    case 'transcript': return p('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
    case 'editor': return p('M12 20h9|M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z');
    case 'recall': return p('M23 7l-7 5 7 5z|M1 5h15v14H1z');
    case 'flow': return p('M6 3v12|M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M15 6a9 9 0 0 1-9 9');
    case 'doclist': return p('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M9 13h6|M9 17h4');
    case 'instruction': return p('M3 21v-4l11-11 4 4L7 21z|M14 6l4 4');
    case 'code': return p('M16 18l6-6-6-6|M8 6l-6 6 6 6');
    case 'graph': return p('M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M8.6 10.5l6.8-4|M8.6 13.5l6.8 4');
    case 'agent': return p('M12 2a3 3 0 0 1 3 3v2a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z|M5 11a7 7 0 0 0 14 0|M12 18v3');
    default: return p('M5 12h14');
  }
}

function Mock({ kind, accent }: { kind: MockKind; accent: string }) {
  switch (kind) {
    case 'transcript':
      return (
        <Panel>
          <MockHead accent={accent}>live transcript</MockHead>
          {[
            ['Nischay', 'Let’s ship the waitlist before the launch.'],
            ['Priya', 'Agreed — I’ll wire the confirmation email.'],
            ['Nischay', 'And scope the bot to the right project.'],
          ].map(([who, line], i) => (
            <div key={i} className="flex gap-2.5 mb-2.5">
              <span style={{ fontSize: '11px', fontFamily: 'var(--mono)', color: accent, width: '52px', flexShrink: 0 }}>{who}</span>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{line}</span>
            </div>
          ))}
          <Chip accent={accent}>✓ captured · 1 decision · 2 action items</Chip>
        </Panel>
      );
    case 'editor':
      return (
        <Panel>
          <MockHead accent={accent}>Architecture.md</MockHead>
          <Line w="88%" /><Line w="72%" /><Line w="80%" />
          <div className="flex items-center gap-1 my-2">
            <Line w="46%" inline />
            <span style={{ width: '2px', height: '13px', background: accent, display: 'inline-block', animation: 'mnemaBlink 1s steps(2) infinite' }} />
          </div>
          <Line w="64%" /><Line w="78%" />
          <Chip accent={GREEN_OK}>synced to 3 flows · 38ms</Chip>
        </Panel>
      );
    case 'recall':
      return (
        <Panel>
          <div className="flex items-center gap-2 mb-4">
            {['N', 'P', 'M'].map((a, i) => (
              <span key={i} style={{ width: '28px', height: '28px', borderRadius: '50%', background: hexA(i === 2 ? accent : '#94a3b8', 0.18), border: `1px solid ${hexA(i === 2 ? accent : '#94a3b8', 0.45)}`, fontSize: '11px', color: i === 2 ? accent : '#cbd5e1', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginLeft: i ? '-9px' : 0 }}>{a}</span>
            ))}
            <span style={{ fontSize: '11px', fontFamily: 'var(--mono)', color: 'var(--text-tertiary)', marginLeft: '8px' }}>Mnema joined · recording</span>
          </div>
          <Wave accent={accent} />
          <Chip accent={accent}>Meet · Zoom · Teams</Chip>
        </Panel>
      );
    case 'flow':
      return (
        <Panel>
          <MockHead accent={accent}>onboarding flow</MockHead>
          {['Architecture', 'MCP read path', 'Pricing'].map((s, i) => (
            <div key={s}>
              <div
                className="flex items-center gap-2.5 px-2.5 py-2 mb-0"
                style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', borderRadius: '8px' }}
              >
                <span style={{ width: '18px', height: '18px', borderRadius: '5px', background: hexA(accent, 0.16), border: `1px solid ${hexA(accent, 0.4)}`, color: accent, fontSize: '9.5px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--mono)' }}>{i + 1}</span>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{s}</span>
                <span style={{ marginLeft: 'auto', fontSize: '9px', fontFamily: 'var(--mono)', color: 'var(--text-quaternary)', textTransform: 'uppercase' }}>doc</span>
              </div>
              {i < 2 && <div style={{ width: '1px', height: '10px', background: hexA(accent, 0.4), margin: '0 0 0 13px' }} />}
            </div>
          ))}
        </Panel>
      );
    case 'doclist':
      return (
        <Panel>
          <MockHead accent={accent}>workspace · 5 docs</MockHead>
          {['Architecture', 'Pricing strategy', 'Onboarding flow', 'Q3 planning', 'Release notes'].map((d, i) => (
            <div key={d} className="flex items-center gap-2.5 py-1.5" style={{ opacity: i === 0 ? 1 : 0.75 }}>
              <span style={{ width: '7px', height: '7px', borderRadius: '2px', background: i === 0 ? accent : 'var(--text-quaternary)' }} />
              <span style={{ fontSize: '12px', color: i === 0 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{d}</span>
              {i === 0 && <span style={{ marginLeft: 'auto', fontSize: '9px', fontFamily: 'var(--mono)', color: accent }}>OPEN</span>}
            </div>
          ))}
        </Panel>
      );
    case 'instruction':
      return (
        <Panel>
          <MockHead accent={accent}>step instruction</MockHead>
          <div style={{ borderLeft: `2px solid ${accent}`, paddingLeft: '10px', marginBottom: '12px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-primary)', fontStyle: 'italic', lineHeight: 1.5 }}>“Read this before the spec — it sets the constraints the agent must honor.”</span>
          </div>
          <Line w="82%" /><Line w="64%" /><Line w="74%" />
        </Panel>
      );
    case 'code':
      return (
        <Panel mono>
          <MockHead accent={accent}>mcp client</MockHead>
          <div style={{ color: 'var(--text-tertiary)' }}>$ claude --mcp mnema</div>
          <div style={{ marginTop: '2px' }}><span style={{ color: accent }}>→</span> <span style={{ color: 'var(--text-secondary)' }}>get_flow(</span><span style={{ color: AMBER }}>"onboarding"</span><span style={{ color: 'var(--text-secondary)' }}>)</span></div>
          <div><span style={{ color: accent }}>→</span> <span style={{ color: 'var(--text-secondary)' }}>search_docs(</span><span style={{ color: AMBER }}>"pricing"</span><span style={{ color: 'var(--text-secondary)' }}>)</span></div>
          <div style={{ color: GREEN_OK, marginTop: '4px' }}>✓ 4 sources · 182ms</div>
        </Panel>
      );
    case 'graph':
      return (
        <Panel>
          <MockHead accent={accent}>knowledge graph</MockHead>
          <MiniGraph accent={accent} />
        </Panel>
      );
    case 'agent':
      return (
        <Panel mono>
          <MockHead accent={accent}>scoped agent</MockHead>
          <div style={{ color: 'var(--text-tertiary)' }}>scope = project:voice-clone</div>
          <div style={{ marginTop: '3px' }}><span style={{ color: accent }}>ask</span> <span style={{ color: 'var(--text-secondary)' }}>“what’s the status?”</span></div>
          <div style={{ color: 'var(--text-secondary)', marginTop: '3px' }}>answers from 1 project</div>
          <Chip accent={GREEN_OK}>0 cross-project leaks</Chip>
        </Panel>
      );
    default:
      return null;
  }
}

const GREEN_OK = '#6BE39B';

function Panel({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <div
      className="absolute left-6 right-6 bottom-0 p-4"
      style={{
        top: 0,
        background: 'rgba(8,9,12,0.6)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid var(--border-subtle)',
        borderBottom: 'none',
        borderTopLeftRadius: '12px',
        borderTopRightRadius: '12px',
        fontFamily: mono ? 'var(--mono)' : 'var(--sans)',
        fontSize: mono ? '11px' : undefined,
        lineHeight: mono ? 1.7 : undefined,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
}

function MockHead({ children, accent }: { children: React.ReactNode; accent: string }) {
  return (
    <div
      className="flex items-center gap-1.5 mb-3 font-mono uppercase"
      style={{ fontSize: '9.5px', letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}
    >
      <span style={{ width: '6px', height: '6px', borderRadius: '2px', background: accent }} />
      {children}
    </div>
  );
}

function Line({ w, inline }: { w: string; inline?: boolean }) {
  return <div style={{ height: '8px', width: w, borderRadius: '3px', background: 'var(--surface-elevated)', margin: inline ? 0 : '7px 0', display: inline ? 'inline-block' : 'block' }} />;
}

function Chip({ children, accent }: { children: React.ReactNode; accent: string }) {
  return (
    <div
      className="inline-flex items-center mt-2 px-2 py-1 font-mono"
      style={{ fontSize: '9.5px', letterSpacing: '0.04em', color: accent, background: hexA(accent, 0.1), border: `1px solid ${hexA(accent, 0.3)}`, borderRadius: '6px' }}
    >
      {children}
    </div>
  );
}

function Wave({ accent }: { accent: string }) {
  const bars = [10, 22, 14, 30, 18, 38, 16, 26, 12, 34, 20, 28, 14, 24, 11, 32, 18, 26, 13, 20, 9, 22];
  return (
    <div className="flex items-center gap-1" style={{ height: '44px' }}>
      {bars.map((h, i) => (
        <span key={i} style={{ width: '3px', height: `${h}px`, borderRadius: '2px', background: hexA(accent, 0.5 + (h / 38) * 0.4) }} />
      ))}
    </div>
  );
}

function MiniGraph({ accent }: { accent: string }) {
  const nodes = [
    { x: 30, y: 40, c: PURPLE, r: 7 },
    { x: 90, y: 22, c: BLUE, r: 5 },
    { x: 120, y: 60, c: AMBER, r: 5 },
    { x: 70, y: 70, c: GREEN, r: 4 },
    { x: 150, y: 30, c: accent, r: 5 },
  ];
  const links: Array<[number, number]> = [[0, 1], [0, 3], [1, 2], [1, 4], [2, 3]];
  return (
    <svg width="100%" height="140" viewBox="0 0 180 100" preserveAspectRatio="xMidYMid meet">
      {links.map(([a, b], i) => (
        <line key={i} x1={nodes[a]!.x} y1={nodes[a]!.y} x2={nodes[b]!.x} y2={nodes[b]!.y} stroke={hexA(nodes[a]!.c, 0.4)} strokeWidth="1" />
      ))}
      {nodes.map((n, i) => (
        <g key={i}>
          <circle cx={n.x} cy={n.y} r={n.r * 2.6} fill={hexA(n.c, 0.18)} />
          <circle cx={n.x} cy={n.y} r={n.r} fill={n.c} />
          <circle cx={n.x} cy={n.y} r={n.r * 0.4} fill="rgba(255,255,255,0.5)" />
        </g>
      ))}
    </svg>
  );
}

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}
