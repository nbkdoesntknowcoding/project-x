// Sprint 5 F.1 — Projects page component
// Design: glassmorphism cards matching dev-tokens.ts token system

import { type JSX, useEffect, useState } from 'react';
import { T, glassCard } from '../../lib/dev-tokens';

interface TaskCounts {
  backlog?: number;
  in_progress?: number;
  review?: number;
  audit_fix?: number;
  done?: number;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string;
  icon: string;
  githubRepoUrl: string | null;
  status: string;
  boardOrder: number;
  taskCounts: TaskCounts;
}

const PROJECT_COLORS = [
  '#f0997b','#fbbf24','#4ade80','#a78bfa',
  '#60a5fa','#f87171','#34d399','#fb923c','#e879f9','#52525b',
] as const;

const ICON_OPTIONS = [
  { key: 'folder',   svg: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg> },
  { key: 'code',     svg: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> },
  { key: 'rocket',   svg: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg> },
  { key: 'brain',    svg: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg> },
  { key: 'bolt',     svg: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg> },
  { key: 'layers',   svg: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg> },
];

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function ProgressBar({ counts }: { counts: TaskCounts }) {
  const total = (counts.backlog ?? 0) + (counts.in_progress ?? 0) + (counts.review ?? 0) + (counts.done ?? 0);
  if (total === 0) return <div style={{ height: 4, borderRadius: 4, background: T.surface3 }} />;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  return (
    <div style={{ height: 4, borderRadius: 4, overflow: 'hidden', display: 'flex', background: T.surface3 }}>
      {(counts.done ?? 0) > 0 && <div style={{ width: pct(counts.done!), background: T.green }} />}
      {(counts.review ?? 0) > 0 && <div style={{ width: pct(counts.review!), background: T.violet }} />}
      {(counts.in_progress ?? 0) > 0 && <div style={{ width: pct(counts.in_progress!), background: T.amber }} />}
    </div>
  );
}

function CreateModal({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<string>(PROJECT_COLORS[0]!);
  const [icon, setIcon] = useState('folder');
  const [githubRepoUrl, setGithubRepoUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, color, icon, githubRepoUrl: githubRepoUrl.trim() || undefined }),
      });
      onCreate();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '9px 12px', borderRadius: 10,
    background: T.surface2, border: `0.5px solid ${T.glassBorder}`,
    color: T.textPrimary, fontSize: 13, outline: 'none',
    boxSizing: 'border-box', fontFamily: T.fontUI, lineHeight: '1.5',
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ ...glassCard, background: T.surface1, border: `0.5px solid ${T.glassBorderStrong}`, borderRadius: 20, padding: 28, width: 500, maxWidth: '90vw', fontFamily: T.fontUI }}>
        <h2 style={{ margin: '0 0 20px', fontSize: 17, fontWeight: 700, color: T.textPrimary, letterSpacing: '-0.02em' }}>New project</h2>

        <form onSubmit={(e) => { void handleSubmit(e); }}>
          {/* Name */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 11, color: T.textMuted, marginBottom: 6, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Name *</label>
            <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. BOPPL Context Engine" autoFocus required />
          </div>

          {/* Description */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 11, color: T.textMuted, marginBottom: 6, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Description</label>
            <textarea style={{ ...inputStyle, height: 72, resize: 'none' }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>

          {/* Color picker */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 11, color: T.textMuted, marginBottom: 8, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Color</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {PROJECT_COLORS.map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)}
                  style={{ width: 22, height: 22, borderRadius: '50%', background: c, border: color === c ? `2px solid ${T.textPrimary}` : '2px solid transparent', cursor: 'pointer', padding: 0, outline: 'none' }}
                />
              ))}
            </div>
          </div>

          {/* Icon picker */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 11, color: T.textMuted, marginBottom: 8, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Icon</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {ICON_OPTIONS.map((opt) => (
                <button key={opt.key} type="button" onClick={() => setIcon(opt.key)}
                  style={{ width: 34, height: 34, borderRadius: 8, border: `0.5px solid ${icon === opt.key ? T.glassBorderStrong : T.glassBorder}`, background: icon === opt.key ? T.surface3 : T.surface2, color: icon === opt.key ? T.textPrimary : T.textMuted, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {opt.svg}
                </button>
              ))}
            </div>
          </div>

          {/* GitHub URL */}
          <div style={{ marginBottom: 22 }}>
            <label style={{ display: 'block', fontSize: 11, color: T.textMuted, marginBottom: 6, fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>GitHub repo URL</label>
            <input style={inputStyle} value={githubRepoUrl} onChange={(e) => setGithubRepoUrl(e.target.value)} placeholder="https://github.com/org/repo" />
          </div>

          {error && <p style={{ fontSize: 12, color: T.red, marginBottom: 12 }}>{error}</p>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={{ padding: '8px 18px', borderRadius: 8, border: `0.5px solid ${T.glassBorder}`, background: 'transparent', color: T.textSecondary, fontSize: 13, cursor: 'pointer', fontFamily: T.fontUI }}>Cancel</button>
            <button type="submit" disabled={saving || !name.trim()} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: T.accent, color: '#0A0B0D', fontSize: 13, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', fontFamily: T.fontUI }}>
              {saving ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ProjectsPage(): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    try {
      const data = await apiFetch<{ projects: Project[] }>('/api/projects?status=active');
      setProjects(data.projects);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const iconMap = Object.fromEntries(ICON_OPTIONS.map((o) => [o.key, o.svg]));

  return (
    <div style={{ padding: '28px 32px', fontFamily: T.fontUI, background: T.bg, minHeight: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.textPrimary, letterSpacing: '-0.02em', fontFamily: T.fontUI }}>Projects</h1>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: T.textMuted }}>{projects.length} active project{projects.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: T.accent, color: '#0A0B0D', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: T.fontUI }}
        >
          + New project
        </button>
      </div>

      {/* Grid */}
      {loading ? (
        <p style={{ color: T.textMuted, fontSize: 13 }}>Loading…</p>
      ) : projects.length === 0 ? (
        <div style={{ ...glassCard, padding: '48px 32px', textAlign: 'center', maxWidth: 480, margin: '0 auto' }}>
          <p style={{ margin: '0 0 8px', fontSize: 15, color: T.textPrimary, fontWeight: 600 }}>No projects yet</p>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: T.textMuted }}>Create a project to organise tasks and docs together.</p>
          <button onClick={() => setShowCreate(true)} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: T.accent, color: '#0A0B0D', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: T.fontUI }}>
            Create first project
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {projects.map((p) => {
            const totalTasks = Object.values(p.taskCounts).reduce((a, b) => (a ?? 0) + (b ?? 0), 0) ?? 0;
            return (
              <div key={p.id} style={{ ...glassCard, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Header row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 16, height: 16, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: T.textPrimary, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.textMuted, fontFamily: T.fontMono, padding: '2px 6px', borderRadius: 4, background: T.surface3 }}>{p.status}</span>
                </div>

                {/* Description */}
                {p.description && (
                  <p style={{ margin: 0, fontSize: 12, color: T.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.description}</p>
                )}

                {/* Progress bar */}
                <ProgressBar counts={p.taskCounts} />

                {/* Footer */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  {/* Left: counts + GitHub */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 11, color: T.textMuted, fontFamily: T.fontMono }}>{totalTasks} task{totalTasks !== 1 ? 's' : ''}</span>
                    {p.githubRepoUrl && (
                      <a href={p.githubRepoUrl} target="_blank" rel="noopener noreferrer" style={{ color: T.textMuted, display: 'flex', alignItems: 'center' }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12"/></svg>
                      </a>
                    )}
                  </div>

                  {/* Right: Docs + Kanban action buttons */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <a
                      href="/app/content"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        fontSize: 12, color: T.textSecondary, fontWeight: 500,
                        textDecoration: 'none', padding: '4px 10px', borderRadius: 7,
                        border: `0.5px solid ${T.glassBorder}`, background: T.glass,
                        fontFamily: T.fontUI,
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
                      Docs
                    </a>
                    <a
                      href={`/app/kanban?project=${p.slug}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        fontSize: 12, color: T.accent, fontWeight: 600,
                        textDecoration: 'none', padding: '4px 10px', borderRadius: 7,
                        border: `0.5px solid rgba(255,179,112,0.3)`, background: `rgba(255,179,112,0.08)`,
                        fontFamily: T.fontUI,
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="13" rx="1"/><rect x="17" y="3" width="5" height="9" rx="1"/></svg>
                      Kanban
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <CreateModal onClose={() => setShowCreate(false)} onCreate={() => { void load(); }} />
      )}
    </div>
  );
}
