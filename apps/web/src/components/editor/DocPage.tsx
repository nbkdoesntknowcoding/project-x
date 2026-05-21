import type { DocFull } from '@boppl/shared';
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { EditorView } from 'prosemirror-view';
import { api } from '../../lib/api';
import { CommentComposer } from '../comments/CommentComposer';
import { CommentsSidebar } from '../comments/CommentsSidebar';
import { SaveVersionMenu } from '../versions/SaveVersionMenu';
import { VersionDiffView } from '../versions/VersionDiffView';
import { VersionsSidebar } from '../versions/VersionsSidebar';
import { Editor, type EditorSelection } from './Editor';
import type { HocuspocusProvider } from '@hocuspocus/provider';

interface DocPageProps {
  initialDoc: DocFull;
  jwt: string;
  user: { id: string; email: string };
  collabUrl?: string;
}

type Role = 'owner' | 'editor' | 'viewer' | null;

/**
 * Editor + comments + versions shell.
 *
 * Owns:
 *   - The EditorView reference (captured via Editor's onViewReady callback).
 *   - The current selection (also bubbled up from Editor).
 *   - Comments sidebar + composer state + unresolved count.
 *   - Versions sidebar + selected-version diff overlay + save / restore
 *     refresh keys.
 *   - The current user's role (fetched once from /api/auth/me) so the
 *     diff overlay can hide the Restore button for viewers.
 *
 * The toolbar lives fixed in the bottom-right corner of the viewport so it
 * doesn't compete with the doc title for visual attention.
 */
export function DocPage({ initialDoc, jwt, user, collabUrl }: DocPageProps): JSX.Element {
  const [title, setTitle] = useState(initialDoc.title);
  const [savedTitle, setSavedTitle] = useState(initialDoc.title);

  const [view, setView] = useState<EditorView | null>(null);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const lastSelectionRef = useRef<EditorSelection | null>(null);

  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);

  const [role, setRole] = useState<Role>(null);

  const [commentsSidebarOpen, setCommentsSidebarOpen] = useState(false);
  const [composerSelection, setComposerSelection] = useState<EditorSelection | null>(null);
  const [commentsRefreshKey, setCommentsRefreshKey] = useState(0);
  const [unresolvedCount, setUnresolvedCount] = useState(0);

  const [versionsSidebarOpen, setVersionsSidebarOpen] = useState(false);
  const [versionsRefreshKey, setVersionsRefreshKey] = useState(0);
  const [diffVersion, setDiffVersion] = useState<number | null>(null);

  // --- title save -----------------------------------------------------------
  // Title save: only patches the title field — never touches markdown.
  // Markdown is the exclusive domain of the Hocuspocus/Yjs collab layer;
  // sending stale initialDoc.markdown here would race with the collab
  // server and silently overwrite in-progress edits.
  const handleTitleBlur = useCallback(async (): Promise<void> => {
    if (title === savedTitle) return;
    await api.saveDoc(initialDoc.id, { title });
    setSavedTitle(title);
    // Keep the browser tab title and SSR breadcrumb in sync without a reload.
    document.title = `${title} — Mnema`;
    const crumbEl = document.querySelector('.dl-crumbs .here');
    if (crumbEl) crumbEl.textContent = title;
  }, [title, savedTitle, initialDoc.id]);

  // --- mark-read on mount --------------------------------------------------
  useEffect(() => {
    const apiUrl =
      (import.meta.env.PUBLIC_API_URL as string | undefined) ?? 'http://localhost:8080';
    void fetch(`${apiUrl}/api/doc-read-state/mark-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ doc_id: initialDoc.id }),
    }).catch(() => {});
  }, [initialDoc.id]);

  // --- one-shot role fetch -------------------------------------------------
  useEffect(() => {
    const apiUrl =
      (import.meta.env.PUBLIC_API_URL as string | undefined) ?? 'http://localhost:8080';
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiUrl}/api/auth/me`, { credentials: 'include' });
        if (!res.ok) return;
        const body = (await res.json()) as { role?: string };
        if (cancelled) return;
        if (body.role === 'owner' || body.role === 'editor' || body.role === 'viewer') {
          setRole(body.role);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  // --- initial unresolved count -------------------------------------------
  useEffect(() => {
    const apiUrl =
      (import.meta.env.PUBLIC_API_URL as string | undefined) ?? 'http://localhost:8080';
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${apiUrl}/api/comment-threads?doc_id=${initialDoc.id}`,
          { credentials: 'include' },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { threads: unknown[] };
        if (!cancelled) setUnresolvedCount(body.threads.length);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [initialDoc.id]);

  // --- selection tracking --------------------------------------------------
  const handleSelectionChange = useCallback((sel: EditorSelection | null) => {
    setSelection(sel);
    if (sel) lastSelectionRef.current = sel;
  }, []);

  // --- ⌘⇧M shortcut -------------------------------------------------------
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const isModShiftM =
        (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'm' || e.key === 'M');
      if (!isModShiftM) return;
      const sel = selection ?? lastSelectionRef.current;
      if (!sel || sel.from === sel.to) return;
      e.preventDefault();
      setComposerSelection(sel);
      setCommentsSidebarOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selection]);

  const handleComposerPosted = useCallback(() => {
    setComposerSelection(null);
    setCommentsSidebarOpen(true);
    setCommentsRefreshKey((k) => k + 1);
  }, []);

  const openCommentsExclusive = useCallback(() => {
    setCommentsSidebarOpen((v) => {
      const next = !v;
      if (next) setVersionsSidebarOpen(false);
      return next;
    });
  }, []);

  const openVersionsExclusive = useCallback(() => {
    setVersionsSidebarOpen((v) => {
      const next = !v;
      if (next) setCommentsSidebarOpen(false);
      return next;
    });
  }, []);

  return (
    <div className="doc-page">
      {/* Title-only row — above the editor body, not part of the fixed toolbar */}
      <input
        className="doc-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={handleTitleBlur}
        placeholder="Untitled"
        autoComplete="off"
        spellCheck
      />

      <div className="relative">
        <Editor
          docId={initialDoc.id}
          initialMarkdown={initialDoc.markdown}
          jwt={jwt}
          user={user}
          collabUrl={collabUrl}
          onViewReady={setView}
          onSelectionChange={handleSelectionChange}
          onProviderReady={setProvider}
        />
        {composerSelection && view && (
          <CommentComposer
            view={view}
            docId={initialDoc.id}
            selectionStart={composerSelection.from}
            selectionEnd={composerSelection.to}
            onPosted={handleComposerPosted}
            onCancel={() => setComposerSelection(null)}
          />
        )}
      </div>

      {/* Fixed top-right toolbar — status + actions */}
      <div
        className="fixed flex items-center gap-1"
        style={{
          top: 86,
          right: 24,
          zIndex: 50,
          background: 'var(--surface-elevated)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-md)',
          padding: '6px 8px',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <BottomStatusPill provider={provider} />

        <div
          style={{
            width: 1,
            height: 14,
            background: 'var(--border-default)',
            margin: '0 4px',
          }}
        />

        <SaveVersionMenu
          docId={initialDoc.id}
          onSaved={() => setVersionsRefreshKey((k) => k + 1)}
        />

        <button
          type="button"
          onClick={openVersionsExclusive}
          className="inline-flex items-center justify-center h-7 px-2.5 rounded transition-[background,color]"
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: versionsSidebarOpen ? 'var(--text-primary)' : 'var(--text-secondary)',
            background: versionsSidebarOpen ? 'var(--surface-overlay)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
          aria-pressed={versionsSidebarOpen}
        >
          Versions
        </button>

        <button
          type="button"
          onClick={openCommentsExclusive}
          className="inline-flex items-center gap-1.5 justify-center h-7 px-2.5 rounded transition-[background,color]"
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: commentsSidebarOpen ? 'var(--text-primary)' : 'var(--text-secondary)',
            background: commentsSidebarOpen ? 'var(--surface-overlay)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
          aria-pressed={commentsSidebarOpen}
        >
          Comments
          {unresolvedCount > 0 && (
            <span
              className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-medium"
              style={{
                background: 'var(--status-info-bg)',
                color: 'var(--status-info)',
                border: '1px solid var(--status-info)',
              }}
            >
              {unresolvedCount}
            </span>
          )}
        </button>
      </div>

      <CommentsSidebar
        docId={initialDoc.id}
        view={view}
        open={commentsSidebarOpen}
        onClose={() => setCommentsSidebarOpen(false)}
        refreshKey={commentsRefreshKey}
        onUnresolvedCountChange={setUnresolvedCount}
      />
      <VersionsSidebar
        docId={initialDoc.id}
        open={versionsSidebarOpen}
        onClose={() => setVersionsSidebarOpen(false)}
        onSelectVersion={(v) => setDiffVersion(v)}
        selectedVersion={diffVersion}
        refreshKey={versionsRefreshKey}
      />
      {diffVersion !== null && (
        <VersionDiffView
          docId={initialDoc.id}
          version={diffVersion}
          role={role}
          onClose={() => setDiffVersion(null)}
          onRestored={() => setVersionsRefreshKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline status pill — renders connection state as a small coloured badge
// ---------------------------------------------------------------------------
import type { HocuspocusProvider as HP } from '@hocuspocus/provider';

function BottomStatusPill({ provider }: { provider: HP | null }): JSX.Element {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'synced' | 'disconnected'>('connecting');
  const [peers, setPeers] = useState(0);

  useEffect(() => {
    if (!provider) return;
    const onStatus = ({ status: s }: { status: string }) => {
      if (s === 'connected') setStatus('connected');
      else if (s === 'disconnected') setStatus('disconnected');
    };
    const onSynced = () => setStatus('synced');
    const onAwareness = () => {
      const states = provider.awareness?.getStates() ?? new Map<number, unknown>();
      setPeers(Math.max(0, states.size - 1));
    };
    provider.on('status', onStatus);
    provider.on('synced', onSynced);
    provider.on('awarenessUpdate', onAwareness);
    onAwareness();
    return () => {
      provider.off('status', onStatus);
      provider.off('synced', onSynced);
      provider.off('awarenessUpdate', onAwareness);
    };
  }, [provider]);

  const tone =
    status === 'synced' ? 'var(--status-success)' :
    status === 'disconnected' ? 'var(--status-error)' :
    'var(--text-tertiary)';

  const label =
    status === 'connecting' ? 'Connecting…' :
    status === 'connected' ? 'Connected' :
    status === 'synced' ? (peers > 0 ? `Synced · ${peers} other${peers === 1 ? '' : 's'}` : 'Synced') :
    'Offline';

  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{ fontSize: 11, fontWeight: 500, color: tone }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: tone,
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}
