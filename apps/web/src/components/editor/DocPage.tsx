import type { DocFull } from '@boppl/shared';
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { EditorView } from 'prosemirror-view';
import { api, setAuthToken } from '../../lib/api';
import { CommentComposer } from '../comments/CommentComposer';
import { CommentsSidebar } from '../comments/CommentsSidebar';
import { VersionDiffView } from '../versions/VersionDiffView';
import { VersionsSidebar } from '../versions/VersionsSidebar';
import { Editor, type EditorSelection } from './Editor';
import { DocToolbar } from './DocToolbar';
import { ShareModal } from './ShareModal';
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

  const [shareModalOpen, setShareModalOpen] = useState(false);

  // Incremented on every selection/state change so DocToolbar re-reads view.state
  const [selectionTick, setSelectionTick] = useState(0);

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

  // --- register JWT for apiFetch calls ------------------------------------
  // apiFetch uses authHeaders() which reads this token. Browser fetches go
  // through the Astro proxy which injects auth server-side, but keeping the
  // token set here ensures it's available for SSR-aware paths too.
  useEffect(() => {
    setAuthToken(jwt);
  }, [jwt]);

  // --- mark-read on mount --------------------------------------------------
  useEffect(() => {
    void fetch(`/api/doc-read-state/mark-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ doc_id: initialDoc.id }),
    }).catch(() => {});
  }, [initialDoc.id]);

  // --- one-shot role fetch -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/auth/me`, {
          credentials: 'include',
        });
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
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/comment-threads?doc_id=${initialDoc.id}`,
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
    // Tick so DocToolbar re-reads view.state for active mark/block states
    setSelectionTick((n) => n + 1);
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
      {/* Unified top toolbar — formatting + doc actions */}
      <DocToolbar
        view={view}
        selectionTick={selectionTick}
        provider={provider}
        docId={initialDoc.id}
        onSavedVersion={() => setVersionsRefreshKey((k) => k + 1)}
        versionsSidebarOpen={versionsSidebarOpen}
        onToggleVersions={openVersionsExclusive}
        commentsSidebarOpen={commentsSidebarOpen}
        onToggleComments={openCommentsExclusive}
        unresolvedCount={unresolvedCount}
        onShare={() => setShareModalOpen(true)}
      />

      {/* Title-only row — above the editor body */}
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

      {shareModalOpen && (
        <ShareModal
          docId={initialDoc.id}
          initialIsPublic={initialDoc.is_public ?? false}
          initialPublicToken={initialDoc.public_token}
          onClose={() => setShareModalOpen(false)}
        />
      )}
    </div>
  );
}

