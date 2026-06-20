import { type JSX, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type Role,
  type MemberRow,
  type OrgTeam,
  type OrgRole,
  type OrgPerson,
  type OrgFolder,
  type OrgGrant,
  type OrgAuditEntry,
} from '../../lib/api';
import { MembersTable } from './MembersTable';
import { PendingInvitations } from './PendingInvitations';

type Tab = 'people' | 'structure' | 'roles' | 'access' | 'audit';
const PERMS = ['none', 'read', 'write', 'admin'] as const;

const ink = 'var(--ink, #e7e7e9)';
const soft = 'var(--ink-soft, #a1a1aa)';
const muted = 'var(--ink-muted, #71717a)';
const line = 'var(--line, rgba(255,255,255,0.1))';
const surface = 'var(--surface-1, rgba(255,255,255,0.02))';
const accent = 'var(--amber, #f0997b)';
const red = 'var(--red, #f87171)';
const green = 'var(--green, #6BE39B)';

const btn: React.CSSProperties = { padding: '7px 14px', borderRadius: 8, border: 'none', background: accent, color: '#0A0B0D', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { padding: '6px 12px', borderRadius: 8, border: `0.5px solid ${line}`, background: 'transparent', color: soft, fontSize: 13, cursor: 'pointer' };
const input: React.CSSProperties = { padding: '7px 10px', borderRadius: 7, border: `0.5px solid ${line}`, background: surface, color: ink, fontSize: 13, outline: 'none' };
const selectStyle: React.CSSProperties = { ...input, padding: '5px 8px', cursor: 'pointer' };
const cell: React.CSSProperties = { border: `0.5px solid ${line}`, padding: '6px 8px', fontSize: 12, color: soft };
const sectionH: React.CSSProperties = { fontSize: 13, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' };

// Group people into their department/team for an org-hierarchy view. Leadership
// floats to the top; everyone without a department lands in "Unassigned" last.
function groupByDepartment<T extends { department: string | null }>(rows: T[], teams: OrgTeam[]): Array<[string, T[]]> {
  const order = new Map(teams.map((t, i) => [t.name, i]));
  const groups = new Map<string, T[]>();
  for (const p of rows) {
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

function inviteError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409 && /already_a_member/.test(err.message)) return 'That person is already a member.';
    if (err.status === 409 && /already_invited/.test(err.message)) return 'There is already a pending invite for that email.';
    if (err.status === 403) return "You can't invite at that role level.";
    if (err.status === 400) return 'That email looks invalid.';
    return 'Could not send invitation. Try again.';
  }
  return 'Network error. Try again.';
}

export function OrgPageRoot({ currentUserId, currentUserRole }: { currentUserId: string; currentUserRole: Role }): JSX.Element {
  const [tab, setTab] = useState<Tab>('people');
  const tabs: Array<[Tab, string]> = [['people', 'People'], ['structure', 'Teams'], ['roles', 'Roles'], ['access', 'Access'], ['audit', 'Audit Log']];

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
      {tab === 'people' && <PeopleTab currentUserId={currentUserId} currentUserRole={currentUserRole} />}
      {tab === 'structure' && <StructureTab currentUserRole={currentUserRole} />}
      {tab === 'roles' && <RolesTab />}
      {tab === 'access' && <AccessTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

// ── People (members + invite) ─────────────────────────────────────────────────
function PeopleTab({ currentUserId, currentUserRole }: { currentUserId: string; currentUserRole: Role }): JSX.Element {
  const [reloadKey, setReloadKey] = useState(0);
  const canManage = currentUserRole === 'owner' || currentUserRole === 'editor';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
      {canManage && (
        <section>
          <h3 style={sectionH}>Add a person</h3>
          <AddPersonForm currentUserRole={currentUserRole} onAdded={() => setReloadKey((k) => k + 1)} />
        </section>
      )}
      {canManage && (
        <section>
          <h3 style={sectionH}>Pending invitations</h3>
          <PendingInvitations reloadKey={reloadKey} />
        </section>
      )}
      <section>
        <h3 style={sectionH}>Current members</h3>
        <MembersTable currentUserId={currentUserId} currentUserRole={currentUserRole} />
      </section>
    </div>
  );
}

// Structured add-person form: name, email, access level + (optional) org role.
// Sends one invitation that pre-wires the title, role and team on accept.
function AddPersonForm({ currentUserRole, onAdded }: { currentUserRole: Role; onAdded: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [wsRole, setWsRole] = useState<Role>('editor');
  const [orgRoleId, setOrgRoleId] = useState('');
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { void api.orgRoles().then((r) => setRoles(r.roles)).catch(() => {}); }, []);
  const wsRoles: Role[] = currentUserRole === 'owner' ? ['owner', 'editor', 'viewer'] : ['editor', 'viewer'];

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!email.trim()) { setMsg({ ok: false, text: 'Email is required.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.createInvitation({
        email: email.trim(), role: wsRole,
        name: name.trim() || undefined,
        orgRoleId: orgRoleId || undefined,
      });
      setMsg({ ok: true, text: `Invitation sent to ${email.trim()}.` });
      setName(''); setEmail(''); setOrgRoleId('');
      onAdded();
    } catch (err) {
      setMsg({ ok: false, text: inviteError(err) });
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ ...input, flex: 1 }} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ ...input, flex: 1 }} type="email" placeholder="name@theboringpeople.in" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 12, color: muted }}>Role
          <select style={{ ...selectStyle, marginLeft: 6 }} value={orgRoleId} onChange={(e) => setOrgRoleId(e.target.value)}>
            <option value="">— No org role —</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: muted }}>Access
          <select style={{ ...selectStyle, marginLeft: 6 }} value={wsRole} onChange={(e) => setWsRole(e.target.value as Role)}>
            {wsRoles.map((r) => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
          </select>
        </label>
        <button type="submit" disabled={busy || !email.trim()} style={{ ...btn, marginLeft: 'auto', opacity: busy || !email.trim() ? 0.5 : 1 }}>
          {busy ? 'Sending…' : 'Send invite'}
        </button>
      </div>
      {msg && <p style={{ fontSize: 12, margin: 0, color: msg.ok ? green : red }}>{msg.text}</p>}
    </form>
  );
}

// ── Teams / structure (editable org chart) ─────────────────────────────────────
function StructureTab({ currentUserRole }: { currentUserRole: Role }): JSX.Element {
  const [teams, setTeams] = useState<OrgTeam[]>([]);
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [people, setPeople] = useState<OrgPerson[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTeam, setNewTeam] = useState('');
  const canManage = currentUserRole === 'owner';

  async function load(): Promise<void> {
    const [s, m] = await Promise.all([
      api.orgStructure(),
      api.listMembers().catch(() => ({ members: [] as MemberRow[] })),
    ]);
    setTeams(s.teams); setRoles(s.roles); setPeople(s.people); setMembers(m.members); setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function addTeam(): Promise<void> {
    if (!newTeam.trim()) return;
    await api.createTeam({ name: newTeam.trim() });
    setNewTeam(''); void load();
  }
  async function assign(userId: string, orgRoleId: string): Promise<void> {
    await api.setOrgPerson(userId, { orgRoleId: orgRoleId || null });
    void load();
  }

  if (loading) return <p style={{ color: muted, fontSize: 14 }}>Loading…</p>;

  const profileByUser = new Map(people.map((p) => [p.userId, p]));
  // One row per workspace member, carrying their current org profile (if any).
  const rows = members.map((m) => {
    const prof = profileByUser.get(m.userId);
    return {
      userId: m.userId,
      label: m.displayName || prof?.displayName || m.email,
      title: prof?.displayTitle ?? null,
      department: prof?.department ?? null,
      roleId: roles.find((r) => r.slug === prof?.roleSlug)?.id ?? '',
    };
  });
  const grouped = groupByDepartment(rows, teams);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input style={{ ...input, flex: 1, maxWidth: 240 }} placeholder="New team name" value={newTeam}
          disabled={!canManage} onChange={(e) => setNewTeam(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTeam()} />
        <button style={{ ...ghostBtn, opacity: canManage ? 1 : 0.5 }} disabled={!canManage} onClick={addTeam}>Add Team</button>
      </div>

      <h3 style={sectionH}>Teams</h3>
      {teams.length === 0 ? <p style={{ color: muted, fontSize: 13 }}>No teams yet.</p> : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 28 }}>
          {teams.map((t) => (
            <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 999, background: surface, border: `0.5px solid ${line}`, fontSize: 13, color: ink }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.color ?? '#6b7280' }} />
              {t.name}
              {canManage && <button onClick={async () => { await api.deleteTeam(t.id); void load(); }} style={{ background: 'none', border: 'none', color: muted, cursor: 'pointer', fontSize: 14 }}>×</button>}
            </span>
          ))}
        </div>
      )}

      <h3 style={sectionH}>People</h3>
      {rows.length === 0 ? <p style={{ color: muted, fontSize: 13 }}>No members yet — invite people from the People tab.</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {grouped.map(([dept, list]) => (
            <div key={dept}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: teams.find((t) => t.name === dept)?.color ?? '#6b7280' }} />
                <span style={{ color: soft, fontSize: 12, fontWeight: 600 }}>{dept}</span>
                <span style={{ color: muted, fontSize: 11 }}>{list.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 16, borderLeft: `0.5px solid ${line}` }}>
                {list.map((p) => (
                  <div key={p.userId} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', borderRadius: 8, background: surface, border: `0.5px solid ${line}` }}>
                    <span style={{ flex: 1, color: ink, fontSize: 13 }}>{p.label}</span>
                    <span style={{ color: soft, fontSize: 12 }}>{p.title || ''}</span>
                    <select style={{ ...selectStyle, opacity: canManage ? 1 : 0.6 }} disabled={!canManage}
                      value={p.roleId} onChange={(e) => assign(p.userId, e.target.value)}>
                      <option value="">— Unassigned —</option>
                      {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
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
