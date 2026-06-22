/** Append-only admin audit log viewer. Read-only. */
import { type JSX, useEffect, useState } from 'react';
import { adminApi, type AdminAuditEntry } from '../../lib/api';

const ink = 'var(--ink)';
const muted = 'var(--ink-muted, #8a8a8a)';
const line = 'var(--border, rgba(0,0,0,0.08))';
const surface = 'var(--surface, #fff)';
const accent = 'var(--accent, #6366f1)';

export function AdminAudit(): JSX.Element {
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    adminApi.audit().then((r) => setEntries(r.entries)).catch((e) => setErr(e instanceof Error ? e.message : 'Failed'));
  }, []);

  if (err) return <div style={{ color: '#ef4444', fontSize: 13 }}>{err}</div>;

  return (
    <div style={{ background: surface, border: `0.5px solid ${line}`, borderRadius: 10, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead><tr>{['When', 'Actor', 'Action', 'Target', 'IP'].map((h) => (
          <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
        ))}</tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} style={{ borderTop: `0.5px solid ${line}` }}>
              <td style={{ ...td, color: muted, whiteSpace: 'nowrap' }}>{fmtDateTime(e.created_at)}</td>
              <td style={td}>{e.actor_email}</td>
              <td style={td}><span style={{ fontFamily: 'var(--mono, monospace)', fontSize: 11.5, color: accent }}>{e.action}</span></td>
              <td style={{ ...td, color: muted, fontSize: 11.5 }}>{e.target_type ? `${e.target_type}:${e.target_id?.slice(0, 8) ?? ''}` : '—'}</td>
              <td style={{ ...td, color: muted, fontSize: 11.5 }}>{e.ip ?? '—'}</td>
            </tr>
          ))}
          {!entries.length && <tr><td style={{ ...td, color: muted }} colSpan={5}>No admin actions recorded yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const td: React.CSSProperties = { padding: '9px 12px', color: ink, verticalAlign: 'top' };
function fmtDateTime(s: string): string {
  try { return new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return s; }
}
