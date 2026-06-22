/**
 * Live VPS log viewer — streams docker logs via the admin SSE proxy.
 * Service dropdown, live tail with auto-scroll, pause, and a text filter.
 */
import { type JSX, useEffect, useRef, useState } from 'react';

const ink = 'var(--ink)';
const muted = 'var(--ink-muted, #8a8a8a)';
const line = 'var(--border, rgba(0,0,0,0.08))';
const surface = 'var(--surface, #fff)';
const accent = 'var(--accent, #6366f1)';

const SERVICES = ['api', 'workers', 'collab', 'meeting-bot', 'pipecat-meeting'] as const;
const MAX_LINES = 2000;

export function AdminLogs(): JSX.Element {
  const [service, setService] = useState<string>('api');
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<'connecting' | 'live' | 'error' | 'paused'>('connecting');
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    setLines([]); setStatus('connecting');
    const es = new EventSource(`/api/admin/logs/stream?service=${encodeURIComponent(service)}&tail=300`, { withCredentials: true });
    es.onopen = () => setStatus('live');
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      try {
        const { line: l } = JSON.parse(ev.data) as { line: string };
        setLines((prev) => {
          const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev;
          return [...next, l];
        });
      } catch { /* ignore malformed */ }
    };
    es.addEventListener('error', () => setStatus('error'));
    return () => es.close();
  }, [service]);

  useEffect(() => {
    if (paused) { setStatus('paused'); return; }
    if (status === 'paused') setStatus('live');
  }, [paused]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!paused && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, paused]);

  const shown = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines;
  const dot = status === 'live' ? '#16a34a' : status === 'error' ? '#ef4444' : status === 'paused' ? '#eab308' : muted;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={service} onChange={(e) => setService(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 8, fontSize: 13, border: `0.5px solid ${line}`, background: surface, color: ink }}>
          {SERVICES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: muted }}>
          <span style={{ width: 8, height: 8, borderRadius: 8, background: dot, display: 'inline-block' }} /> {status}
        </span>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter lines…"
          style={{ padding: '6px 10px', borderRadius: 8, fontSize: 12.5, border: `0.5px solid ${line}`, background: surface, color: ink, width: 220 }} />
        <button onClick={() => setPaused((p) => !p)} style={btn(paused ? accent : muted)}>{paused ? 'Resume' : 'Pause'}</button>
        <button onClick={() => setLines([])} style={btn(muted)}>Clear</button>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: muted }}>{shown.length} lines</span>
      </div>

      <div ref={scrollRef} style={{
        background: '#0b0d12', color: '#cbd5e1', borderRadius: 10, border: `0.5px solid ${line}`,
        fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 11.5, lineHeight: 1.5,
        padding: '12px 14px', height: '62vh', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {shown.length === 0
          ? <span style={{ color: '#64748b' }}>{status === 'error' ? 'Stream unavailable — is the log-streamer deployed? (infra/log-streamer + compose service)' : 'Waiting for log output…'}</span>
          : shown.map((l, i) => <div key={i} style={lineColor(l)}>{l}</div>)}
      </div>
    </div>
  );
}

function btn(color: string): React.CSSProperties {
  return { fontSize: 12, fontWeight: 500, color, background: 'none', border: `0.5px solid ${color}`, borderRadius: 7, padding: '5px 11px', cursor: 'pointer' };
}
function lineColor(l: string): React.CSSProperties {
  const s = l.toLowerCase();
  if (s.includes('error') || s.includes('"level":50') || s.includes('fatal')) return { color: '#f87171' };
  if (s.includes('warn') || s.includes('"level":40')) return { color: '#fbbf24' };
  return {};
}
