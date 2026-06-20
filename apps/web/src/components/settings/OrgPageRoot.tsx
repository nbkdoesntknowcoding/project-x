import { type JSX, useEffect, useState } from 'react';
import {
  api,
  type OrgTeam,
  type OrgRole,
  type OrgPerson,
  type OrgFolder,
  type OrgGrant,
  type OrgAuditEntry,
  type OrgStructure,
} from '../../lib/api';

type Tab = 'structure' | 'roles' | 'access' | 'audit';
const PERMS = ['none', 'read', 'write', 'admin'] as const;

const ink = 'var(--ink, #e7e7e9)';
const soft = 'var(--ink-soft, #a1a1aa)';
const muted = 'var(--ink-muted, #71717a)';
const line = 'var(--line, rgba(255,255,255,0.1))';
const surface = 'var(--surface-1, rgba(255,255,255,0.02))';
const accent = 'var(--amber, #f0997b)';

const btn: React.CSSProperties = { padding: '7px 14px', borderRadius: 8, border: 'none', background: accent, color: '#0A0B0D', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { padding: '6px 12px', borderRadius: 8, border: `0.5px solid ${line}`, background: 'transparent', color: soft, fontSize: 13, cursor: 'pointer' };
const input: React.CSSProperties = { padding: '7px 10px', borderRadius: 7, border: `0.5px solid ${line}`, background: surface, color: ink, fontSize: 13, outline: 'none' };
const cell: React.CSSProperties = { border: `0.5px solid ${line}`, padding: '6px 8px', fontSize: 12, color: soft };

// Group people into their department/team for an org-hierarchy view. Leadership
// floats to the top; everyone without a department lands in "Unassigned" last.
function groupByDepartment(people: OrgPerson[], teams: OrgTeam[]): Array<[string, OrgPerson[]]> {
  const order = new Map(teams.map((t, i) => [t.name, i]));
  const groups = new Map<string, OrgPerson[]>();
  for (const p of people) {
    const key = p.department?.trim() || 'Unassigned';
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  }
  const rank = (name: string): number => {
    if (name === 'Leadership') return -1;
    if (name === 'Unassigned') return 1e6;
    return order.get(name) ?? 1e5;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

export function OrgPageRoot(): JSX.Element {
  const [tab, setTab] = useState<Tab>('structure');
  const tabs: Array<[Tab, string]> = [['structure', 'Structure'], ['roles', 'Roles'], ['access', 'Access'], ['audit', 'Audit Log']];

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, borderBottom: `0.5px solid ${line}`, marginBottom: 22 }}>
        {tabs.map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 14px', background: 'transparent', border: 'none', cursor: 'pointer',
            fontSize: 13, color: tab === t ? ink : muted, fontWeight: tab === t ? 600 : 400,
            borderBottom: `2px solid ${tab === t ? accent : 'transparent'}`, marginBottom: -1,
          }}>{label}</button>
        ))}
      </div>
      {tab === 'structure' && <StructureTab />}
      {tab === 'roles' && <RolesTab />}
      {tab === 'access' && <AccessTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

// ── Structure ───────────────────────────────────────────────────────────────
function StructureTab(): JSX.Element {
  const [teams, setTeams] = useState<OrgTeam[]>([]);
  const [people, setPeople] = useState<OrgPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTeam, setNewTeam] = useState('');
  const [wizard, setWizard] = useState(false);

  async function load() {
    const s = await api.orgStructure();
    setTeams(s.teams); setPeople(s.people); setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function addTeam() {
    if (!newTeam.trim()) return;
    await api.createTeam({ name: newTeam.trim() });
    setNewTeam(''); void load();
  }

  if (loading) return <p style={{ color: muted, fontSize: 14 }}>Loading…</p>;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button style={btn} onClick={() => setWizard(true)}>Import Org Chart</button>
        <input style={{ ...input, flex: 1, maxWidth: 240 }} placeholder="New team name" value={newTeam}
          onChange={(e) => setNewTeam(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTeam()} />
        <button style={ghostBtn} onClick={addTeam}>Add Team</button>
      </div>

      <h3 style={{ fontSize: 13, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>Teams</h3>
      {teams.length === 0 ? <p style={{ color: muted, fontSize: 13 }}>No teams yet. Import an org chart or add one.</p> : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 28 }}>
          {teams.map((t) => (
            <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 999, background: surface, border: `0.5px solid ${line}`, fontSize: 13, color: ink }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color ?? '#6b7280' }} />
              {t.name}
              <button onClick={async () => { await api.deleteTeam(t.id); void load(); }} style={{ background: 'none', border: 'none', color: muted, cursor: 'pointer', fontSize: 14 }}>×</button>
            </span>
          ))}
        </div>
      )}

      <h3 style={{ fontSize: 13, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 10px' }}>People</h3>
      {people.length === 0 ? <p style={{ color: muted, fontSize: 13 }}>No org profiles yet — they appear once invited members accept with a role.</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {groupByDepartment(people, teams).map(([dept, members]) => (
            <div key={dept}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: teams.find((t) => t.name === dept)?.color ?? '#6b7280' }} />
                <span style={{ color: soft, fontSize: 12, fontWeight: 600 }}>{dept}</span>
                <span style={{ color: muted, fontSize: 11 }}>{members.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16, borderLeft: `0.5px solid ${line}` }}>
                {members.map((p) => (
                  <div key={p.userId} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', borderRadius: 8, background: surface, border: `0.5px solid ${line}` }}>
                    <span style={{ flex: 1, color: ink, fontSize: 13 }}>{p.displayName || p.email}</span>
                    <span style={{ color: soft, fontSize: 12 }}>{p.displayTitle || '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {wizard && <ImportWizard onClose={() => setWizard(false)} onDone={() => { setWizard(false); void load(); }} />}
    </div>
  );
}

// ── Roles ─────────────────────────────────────────────────────────────────────
function RolesTab(): JSX.Element {
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [teams, setTeams] = useState<OrgTeam[]>([]);
  const [newRole, setNewRole] = useState('');

  async function load() {
    const [r, t] = await Promise.all([api.orgRoles(), api.orgTeams()]);
    setRoles(r.roles); setTeams(t.teams);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input style={{ ...input, maxWidth: 240 }} placeholder="New role (e.g. CTO)" value={newRole} onChange={(e) => setNewRole(e.target.value)} />
        <button style={ghostBtn} onClick={async () => { if (!newRole.trim()) return; await api.createOrgRole({ name: newRole.trim() }); setNewRole(''); void load(); }}>Add Role</button>
      </div>
      {roles.length === 0 ? <p style={{ color: muted, fontSize: 13 }}>No roles yet.</p> : roles.map((r) => (
        <div key={r.id} style={{ padding: '12px 14px', borderRadius: 10, background: surface, border: `0.5px solid ${line}`, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: ink, fontSize: 14, fontWeight: 500 }}>{r.name}</span>
            <span style={{ color: muted, fontSize: 12, fontFamily: 'var(--mono, monospace)' }}>{r.slug}</span>
            <span style={{ marginLeft: 'auto', color: soft, fontSize: 12 }}>ceiling: {r.workspaceRole}</span>
            <span style={{ color: muted, fontSize: 12 }}>team: {teams.find((t) => t.id === r.teamId)?.name ?? '—'}</span>
            <button onClick={async () => { await api.deleteOrgRole(r.id); void load(); }} style={{ background: 'none', border: 'none', color: muted, cursor: 'pointer' }}>×</button>
          </div>
          <div style={{ marginTop: 6, color: muted, fontSize: 12 }}>
            Default access: {(r.defaultFolderAccess ?? []).map((f) => `${f.folder_slug}:${f.permission}`).join(', ') || 'none'}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Access matrix ───────────────────────────────────────────────────────────
function AccessTab(): JSX.Element {
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [folders, setFolders] = useState<OrgFolder[]>([]);
  const [grants, setGrants] = useState<OrgGrant[]>([]);

  async function load() {
    const [r, f, g] = await Promise.all([api.orgRoles(), api.orgFolders(), api.orgAccess()]);
    setRoles(r.roles); setFolders(f.folders.filter((x) => x.slug)); setGrants(g.grants);
  }
  useEffect(() => { void load(); }, []);

  function permOf(roleId: string, folderId: string): string {
    return grants.find((x) => x.principalType === 'org_role' && x.principalId === roleId && x.resourceId === folderId)?.permission ?? 'none';
  }
  async function setCell(roleId: string, folderId: string, permission: string) {
    await api.setOrgAccess({ principalType: 'org_role', principalId: roleId, resourceType: 'folder', resourceId: folderId, permission });
    void load();
  }

  if (roles.length === 0 || folders.length === 0)
    return <p style={{ color: muted, fontSize: 13 }}>Add roles and team folders first — the matrix maps roles to folders.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr><th style={{ ...cell, color: muted }}>Role \ Folder</th>{folders.map((f) => <th key={f.id} style={{ ...cell, color: ink }}>{f.name}</th>)}</tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id}>
              <td style={{ ...cell, color: ink }}>{r.name}</td>
              {folders.map((f) => (
                <td key={f.id} style={cell}>
                  <select value={permOf(r.id, f.id)} onChange={(e) => setCell(r.id, f.id, e.target.value)}
                    style={{ background: surface, color: ink, border: `0.5px solid ${line}`, borderRadius: 5, padding: '3px 5px', fontSize: 11 }}>
                    {PERMS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Audit ─────────────────────────────────────────────────────────────────────
function AuditTab(): JSX.Element {
  const [entries, setEntries] = useState<OrgAuditEntry[]>([]);
  useEffect(() => { void api.orgAudit().then((r) => setEntries(r.entries)); }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {entries.length === 0 ? <p style={{ color: muted, fontSize: 13 }}>No IAM changes yet.</p> : entries.map((e) => (
        <div key={e.id} style={{ display: 'flex', gap: 12, padding: '7px 12px', borderRadius: 7, background: surface, border: `0.5px solid ${line}`, fontSize: 12 }}>
          <span style={{ color: muted, fontFamily: 'var(--mono, monospace)' }}>{new Date(e.createdAt).toLocaleString()}</span>
          <span style={{ color: accent }}>{e.action}</span>
          <span style={{ color: soft }}>{e.resourceType}</span>
        </div>
      ))}
    </div>
  );
}

// ── Import wizard ─────────────────────────────────────────────────────────────
function ImportWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [text, setText] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [importId, setImportId] = useState<string | undefined>();
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function extract() {
    setBusy(true); setErr(null);
    try {
      const body = imageUrl ? { type: 'image' as const, file_url: imageUrl } : { type: 'description' as const, text };
      const r = await api.orgImportExtract(body);
      setImportId(r.import_id);
      setJson(JSON.stringify(r.extracted_structure, null, 2));
      setStep(2);
    } catch (e) { setErr(e instanceof Error ? e.message : 'extraction failed'); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setErr(null);
    try {
      const structure = JSON.parse(json) as OrgStructure;
      await api.orgImportApply({ import_id: importId, confirmed_structure: structure });
      setStep(3);
    } catch (e) { setErr(e instanceof Error ? e.message : 'apply failed'); }
    finally { setBusy(false); }
  }

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80 }}>
      <div style={{ width: 'min(640px, 92vw)', maxHeight: '86vh', overflow: 'auto', background: 'var(--surface-2, #16161a)', border: `0.5px solid ${line}`, borderRadius: 14, padding: 22 }}>
        <h2 style={{ margin: '0 0 4px', color: ink, fontSize: 17 }}>Import Org Chart</h2>
        <p style={{ margin: '0 0 16px', color: muted, fontSize: 12 }}>Step {step} of 3 — {step === 1 ? 'describe or upload' : step === 2 ? 'review extraction' : 'done'}</p>

        {step === 1 && (
          <>
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste an org description, or an Excel pasted as text (Name, Email, Department, Role, Manager)…"
              style={{ ...input, width: '100%', minHeight: 160, resize: 'vertical', fontFamily: 'inherit' }} />
            <p style={{ color: muted, fontSize: 11, margin: '8px 0' }}>…or an image URL of an org chart:</p>
            <input style={{ ...input, width: '100%' }} placeholder="https://…/org-chart.png" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button style={ghostBtn} onClick={onClose}>Cancel</button>
              <button style={btn} disabled={busy || (!text.trim() && !imageUrl.trim())} onClick={extract}>{busy ? 'Extracting…' : 'Extract with AI'}</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p style={{ color: soft, fontSize: 12, margin: '0 0 8px' }}>Review + edit the extracted structure (teams / roles / people). Apply creates teams, roles, team folders, and sends invitations.</p>
            <textarea value={json} onChange={(e) => setJson(e.target.value)} style={{ ...input, width: '100%', minHeight: 280, fontFamily: 'var(--mono, monospace)', fontSize: 11.5, resize: 'vertical' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button style={ghostBtn} onClick={() => setStep(1)}>Back</button>
              <button style={btn} disabled={busy} onClick={apply}>{busy ? 'Applying…' : 'Confirm & Apply'}</button>
            </div>
          </>
        )}

        {step === 3 && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <p style={{ color: ink, fontSize: 15, margin: '0 0 6px' }}>Org applied ✓</p>
            <p style={{ color: muted, fontSize: 13, margin: '0 0 18px' }}>Teams, roles and folders created; invitations sent.</p>
            <button style={btn} onClick={onDone}>Done</button>
          </div>
        )}

        {err && <p style={{ color: 'var(--red, #f87171)', fontSize: 12, marginTop: 12 }}>{err}</p>}
      </div>
    </div>
  );
}
