/**
 * Admin dashboard — system health strip + Workspaces / Users / Usage tabs.
 * Staff-only (the page guards by email; every API call re-checks server-side).
 */
import { type JSX, useEffect, useState } from 'react';
import {
  adminApi, type AdminWorkspace, type AdminUser, type AdminHealth, type AdminUsage,
} from '../../lib/api';

const ink = 'var(--ink)';
const soft = 'var(--ink-soft)';
const muted = 'var(--ink-muted, #8a8a8a)';
const line = 'var(--border, rgba(0,0,0,0.08))';
const surface = 'var(--surface, #fff)';
const accent = 'var(--accent, #6366f1)';

type Tab = 'workspaces' | 'users' | 'usage';

export function AdminDashboard(): JSX.Element {
  const [tab, setTab] = useState<Tab>('workspaces');
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usage, setUsage] = useState<AdminUsage | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function loadAll() {
    setErr(null);
    try {
      const [h, w, u, us] = await Promise.all([
        adminApi.health().catch(() => null),
        adminApi.workspaces(),
        adminApi.users(),
        adminApi.usage().catch(() => null),
      ]);
      setHealth(h); setWorkspaces(w.workspaces); setUsers(u.users); setUsage(us);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load');
    }
  }
  useEffect(() => { void loadAll(); }, []);

  async function toggleSuspend(w: AdminWorkspace) {
    const next = !w.suspended;
    if (!confirm(`${next ? 'Suspend' : 'Reactivate'} "${w.name}"? ${next ? 'Its members will be blocked from the app.' : ''}`)) return;
    setBusy(w.id);
    try {
      if (next) await adminApi.suspend(w.id); else await adminApi.reactivate(w.id);
      await loadAll();
    } finally { setBusy(null); }
  }

  const wsFiltered = workspaces.filter((w) =>
    !q || w.name.toLowerCase().includes(q.toLowerCase()) || (w.owner_email ?? '').toLowerCase().includes(q.toLowerCase()));
  const usersFiltered = users.filter((u) => !q || u.email.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      {err && <div style={{ ...box, borderColor: '#ef4444', color: '#ef4444', marginBottom: 16 }}>{err}</div>}

      {/* health strip */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <Stat label="Workspaces" value={usage?.totals.workspaces ?? workspaces.length} />
        <Stat label="Users" value={usage?.totals.users ?? users.length} />
        <Stat label="Docs" value={usage?.totals.docs ?? '—'} />
        <Stat label="Meetings" value={usage?.totals.meetings ?? '—'} />
        <Stat label="Database" value={health ? (health.db ? 'up' : 'down') : '…'} good={health?.db} />
        {health && Object.entries(health.queues).map(([name, c]) => (
          <Stat key={name} label={name} value={queueLabel(c)} />
        ))}
      </div>

      {/* tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${line}`, marginBottom: 16 }}>
        {(['workspaces', 'users', 'usage'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={tabBtn(tab === t)}>
            {t === 'workspaces' ? 'Workspaces' : t === 'users' ? 'Users' : 'Usage'}
          </button>
        ))}
        {tab !== 'usage' && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
            style={{ marginLeft: 'auto', padding: '5px 10px', borderRadius: 7, fontSize: 12.5, border: `0.5px solid ${line}`, background: surface, color: ink, width: 220 }} />
        )}
      </div>

      {tab === 'workspaces' && (
        <Table head={['Workspace', 'Plan', 'Owner', 'Members', 'Created', '']}>
          {wsFiltered.map((w) => (
            <tr key={w.id} style={{ borderTop: `0.5px solid ${line}` }}>
              <td style={td}>
                {w.name}{' '}
                {w.suspended && <span style={pill('#ef4444')}>suspended</span>}
                <div style={{ fontSize: 11, color: muted }}>{w.slug}</div>
              </td>
              <td style={td}><span style={pill(planColor(w.plan))}>{w.plan}</span></td>
              <td style={{ ...td, color: soft }}>{w.owner_email ?? '—'}</td>
              <td style={td}>{w.members}</td>
              <td style={{ ...td, color: muted }}>{fmtDate(w.created_at)}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                <button disabled={busy === w.id} onClick={() => toggleSuspend(w)}
                  style={smallBtn(w.suspended ? accent : '#ef4444')}>
                  {busy === w.id ? '…' : w.suspended ? 'Reactivate' : 'Suspend'}
                </button>
              </td>
            </tr>
          ))}
        </Table>
      )}

      {tab === 'users' && (
        <Table head={['Email', 'Name', 'Workspaces', 'Last login', 'Joined']}>
          {usersFiltered.map((u) => (
            <tr key={u.id} style={{ borderTop: `0.5px solid ${line}` }}>
              <td style={td}>{u.email}</td>
              <td style={{ ...td, color: soft }}>{u.display_name ?? '—'}</td>
              <td style={td}>{u.workspaces}</td>
              <td style={{ ...td, color: muted }}>{u.last_login_at ? fmtDate(u.last_login_at) : '—'}</td>
              <td style={{ ...td, color: muted }}>{fmtDate(u.created_at)}</td>
            </tr>
          ))}
        </Table>
      )}

      {tab === 'usage' && (
        <Table head={['Workspace', 'Plan', 'Sessions', 'Est. cost (USD)', 'Last session']}>
          {(usage?.per_workspace ?? []).map((r, i) => (
            <tr key={i} style={{ borderTop: `0.5px solid ${line}` }}>
              <td style={td}>{String(r.name ?? '—')}</td>
              <td style={td}><span style={pill(planColor(String(r.plan)))}>{String(r.plan)}</span></td>
              <td style={td}>{Number(r.sessions ?? 0)}</td>
              <td style={td}>${Number(r.cost_usd ?? 0).toFixed(2)}</td>
              <td style={{ ...td, color: muted }}>{r.last_session_at ? fmtDate(String(r.last_session_at)) : '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

function Stat({ label, value, good }: { label: string; value: string | number; good?: boolean }): JSX.Element {
  const color = good === undefined ? ink : good ? '#16a34a' : '#ef4444';
  return (
    <div style={{ ...box, minWidth: 120, padding: '10px 14px' }}>
      <div style={{ fontSize: 11, color: muted, textTransform: 'capitalize' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }): JSX.Element {
  return (
    <div style={box}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>{head.map((h, i) => (
            <th key={i} style={{ textAlign: i === head.length - 1 ? 'right' : 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const box: React.CSSProperties = { background: surface, border: `0.5px solid ${line}`, borderRadius: 10, overflow: 'hidden' };
const td: React.CSSProperties = { padding: '10px 12px', color: ink, verticalAlign: 'top' };
function tabBtn(active: boolean): React.CSSProperties {
  return { padding: '8px 12px', fontSize: 13, fontWeight: active ? 600 : 400, color: active ? ink : muted, background: 'none', border: 'none', borderBottom: `2px solid ${active ? accent : 'transparent'}`, cursor: 'pointer', marginBottom: -1 };
}
function pill(color: string): React.CSSProperties {
  return { fontSize: 10.5, fontWeight: 600, color, background: `color-mix(in srgb, ${color} 12%, transparent)`, padding: '1px 7px', borderRadius: 20, textTransform: 'capitalize' };
}
function smallBtn(color: string): React.CSSProperties {
  return { fontSize: 12, fontWeight: 500, color, background: 'none', border: `0.5px solid ${color}`, borderRadius: 7, padding: '4px 10px', cursor: 'pointer' };
}
function planColor(plan: string): string {
  return plan === 'team' || plan === 'business' ? '#16a34a' : plan === 'individual' ? accent : muted;
}
function queueLabel(c: unknown): string {
  if (!c || typeof c !== 'object') return '—';
  const o = c as Record<string, number>;
  if ('error' in o) return 'err';
  return `${o.waiting ?? 0}w ${o.active ?? 0}a ${o.failed ?? 0}f`;
}
function fmtDate(s: string): string {
  try { return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return s; }
}
