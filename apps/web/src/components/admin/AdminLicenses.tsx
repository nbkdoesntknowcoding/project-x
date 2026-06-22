/**
 * License management — create plans/keys, list, assign to a workspace, suspend/revoke.
 * Staff-only. Mirrors AdminDashboard's aesthetic.
 */
import { type JSX, useEffect, useState } from 'react';
import { adminApi, type AdminLicense, type AdminWorkspace } from '../../lib/api';

const ink = 'var(--ink)';
const soft = 'var(--ink-soft)';
const muted = 'var(--ink-muted, #8a8a8a)';
const line = 'var(--border, rgba(0,0,0,0.08))';
const surface = 'var(--surface, #fff)';
const accent = 'var(--accent, #6366f1)';

const PLANS = ['free', 'individual', 'team', 'business'] as const;

export function AdminLicenses(): JSX.Element {
  const [licenses, setLicenses] = useState<AdminLicense[]>([]);
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // create form
  const [plan, setPlan] = useState<string>('team');
  const [seats, setSeats] = useState(5);
  const [expires, setExpires] = useState('');
  const [genKey, setGenKey] = useState(true);
  const [bindWs, setBindWs] = useState('');
  const [notes, setNotes] = useState('');

  async function load() {
    setErr(null);
    try {
      const [l, w] = await Promise.all([adminApi.licenses(), adminApi.workspaces()]);
      setLicenses(l.licenses); setWorkspaces(w.workspaces);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load'); }
  }
  useEffect(() => { void load(); }, []);

  async function create() {
    setCreating(true); setErr(null);
    try {
      await adminApi.createLicense({
        plan_tier: plan, seats,
        expires_at: expires ? new Date(expires).toISOString() : null,
        generate_key: genKey, workspace_id: bindWs || null, notes: notes || undefined,
      });
      setExpires(''); setNotes(''); setBindWs('');
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to create'); }
    finally { setCreating(false); }
  }

  async function assign(lic: AdminLicense) {
    const ws = prompt('Assign to which workspace? Paste the workspace ID (see Dashboard).');
    if (!ws) return;
    try { await adminApi.assignLicense(lic.id, ws.trim()); await load(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
  }
  async function setStatus(lic: AdminLicense, status: string) {
    try { await adminApi.updateLicense(lic.id, { status }); await load(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed'); }
  }

  return (
    <div>
      {err && <div style={{ ...box, borderColor: '#ef4444', color: '#ef4444', padding: 12, marginBottom: 16 }}>{err}</div>}

      {/* create */}
      <div style={{ ...box, padding: 16, marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: ink, marginBottom: 12 }}>Create license</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Plan">
            <select value={plan} onChange={(e) => setPlan(e.target.value)} style={input}>
              {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Seats">
            <input type="number" min={1} value={seats} onChange={(e) => setSeats(Math.max(1, +e.target.value))} style={{ ...input, width: 70 }} />
          </Field>
          <Field label="Expires (optional)">
            <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} style={input} />
          </Field>
          <Field label="Bind to workspace (optional)">
            <select value={bindWs} onChange={(e) => setBindWs(e.target.value)} style={{ ...input, width: 200 }}>
              <option value="">— issue unassigned —</option>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Notes">
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Acme annual" style={{ ...input, width: 180 }} />
          </Field>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: soft, paddingBottom: 6 }}>
            <input type="checkbox" checked={genKey} onChange={(e) => setGenKey(e.target.checked)} /> Generate key
          </label>
          <button disabled={creating} onClick={create} style={{ ...primaryBtn, marginBottom: 2 }}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>

      {/* list */}
      <div style={box}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>{['Plan', 'Key', 'Workspace', 'Seats', 'Status', 'Expires', ''].map((h, i) => (
            <th key={i} style={{ textAlign: i === 6 ? 'right' : 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
          ))}</tr></thead>
          <tbody>
            {licenses.map((l) => (
              <tr key={l.id} style={{ borderTop: `0.5px solid ${line}` }}>
                <td style={td}><span style={pill(accent)}>{l.plan_tier}</span></td>
                <td style={{ ...td, fontFamily: 'var(--mono, monospace)', fontSize: 11.5 }}>
                  {l.license_key
                    ? <button onClick={() => { void navigator.clipboard?.writeText(l.license_key!); }} style={{ background: 'none', border: 'none', color: soft, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', padding: 0 }} title="Click to copy">{l.license_key}</button>
                    : <span style={{ color: muted }}>—</span>}
                </td>
                <td style={{ ...td, color: soft }}>{l.workspace_name ?? <span style={{ color: muted }}>unassigned</span>}</td>
                <td style={td}>{l.seats}</td>
                <td style={td}><span style={pill(statusColor(l.status))}>{l.status}</span></td>
                <td style={{ ...td, color: muted }}>{l.expires_at ? fmtDate(l.expires_at) : 'never'}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {!l.workspace_id && <button onClick={() => assign(l)} style={smallBtn(accent)}>Assign</button>}{' '}
                  {l.status !== 'suspended'
                    ? <button onClick={() => setStatus(l, 'suspended')} style={smallBtn('#ef4444')}>Suspend</button>
                    : <button onClick={() => setStatus(l, 'active')} style={smallBtn('#16a34a')}>Activate</button>}{' '}
                  {l.status !== 'revoked' && <button onClick={() => { if (confirm('Revoke this license?')) void setStatus(l, 'revoked'); }} style={smallBtn(muted)}>Revoke</button>}
                </td>
              </tr>
            ))}
            {!licenses.length && <tr><td style={{ ...td, color: muted }} colSpan={7}>No licenses yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: muted }}>{label}</span>
      {children}
    </div>
  );
}

const box: React.CSSProperties = { background: surface, border: `0.5px solid ${line}`, borderRadius: 10, overflow: 'hidden' };
const td: React.CSSProperties = { padding: '10px 12px', color: ink, verticalAlign: 'middle' };
const input: React.CSSProperties = { padding: '6px 9px', borderRadius: 7, fontSize: 12.5, border: `0.5px solid ${line}`, background: surface, color: ink };
const primaryBtn: React.CSSProperties = { padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, color: '#fff', background: accent, border: 'none', cursor: 'pointer' };
function pill(color: string): React.CSSProperties {
  return { fontSize: 10.5, fontWeight: 600, color, background: `color-mix(in srgb, ${color} 12%, transparent)`, padding: '1px 7px', borderRadius: 20, textTransform: 'capitalize' };
}
function smallBtn(color: string): React.CSSProperties {
  return { fontSize: 11.5, fontWeight: 500, color, background: 'none', border: `0.5px solid ${color}`, borderRadius: 6, padding: '3px 8px', cursor: 'pointer' };
}
function statusColor(s: string): string {
  return s === 'active' ? '#16a34a' : s === 'suspended' || s === 'expired' ? '#ef4444' : s === 'revoked' ? muted : accent;
}
function fmtDate(s: string): string {
  try { return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return s; }
}
