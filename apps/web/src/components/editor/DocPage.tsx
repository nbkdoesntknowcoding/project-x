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

interface DocPageProps {
  initialDoc: DocFull;
  jwt: string;
  user: { id: string; email: string };
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
 * On mount we POST /api/doc-read-state/mark-read so the doc's "unread
 * comments" indicator in the doc list clears for this user.
 */
export function DocPage({ initialDoc, jwt, user }: DocPageProps): JSX.Element {
  const [title, setTitle] = useState(initialDoc.title);
  const [savedTitle, setSavedTitle] = useState(initialDoc.title);

  const [view, setView] = useState<EditorView | null>(null);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const lastSelectionRef = useRef<EditorSelection | null>(null);

  const [role, setRole] = useState<Role>(null);

  const [commentsSidebarOpen, setCommentsSidebarOpen] = useState(false);
  const [composerSelection, setComposerSelection] = useState<EditorSelection | null>(null);
  const [commentsRefreshKey, setCommentsRefreshKey] = useState(0);
  const [unresolvedCount, setUnresolvedCount] = useState(0);

  const [versionsSidebarOpen, setVersionsSidebarOpen] = useState(false);
  const [versionsRefreshKey, setVersionsRefreshKey] = useState(0);
  const [diffVersion, setDiffVersion] = useState<number | null>(null);

  // --- title save (unchanged from prior phase) -----------------------------
  const handleTitleBlur = useCallback(async (): Promise<void> => {
    if (title === savedTitle) return;
    await api.saveDoc(initialDoc.id, { title, markdown: initialDoc.markdown });
    setSavedTitle(title);
  }, [title, savedTitle, initialDoc.id, initialDoc.markdown]);

  // --- mark-read on mount --------------------------------------------------
  useEffect(() => {
    const apiUrl =
      (import.meta.env.PUBLIC_API_URL as string | undefined) ?? 'http://localhost:8080';
    void fetch(`${apiUrl}/api/doc-read-state/mark-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ doc_id: initialDoc.id }),
    }).catch(() => {
      // Non-fatal — the indicator just stays for this user.
    });
  }, [initialDoc.id]);

  // --- one-shot role fetch -------------------------------------------------
  // Used by VersionDiffView to decide whether to show the Restore button.
  // Backend still enforces the gate (POST /api/doc-versions/restore is
  // editor+) — this is purely so viewers don't see a button that always
  // 403s.
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
      } catch {
        /* leave role null; restore button stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- initial unresolved count for the header badge ----------------------
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
      } catch {
        /* non-fatal — sidebar open will repopulate */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialDoc.id]);

  // --- selection tracking --------------------------------------------------
  const handleSelectionChange = useCallback((sel: EditorSelection | null) => {
    setSelection(sel);
    if (sel) lastSelectionRef.current = sel;
  }, []);

  // --- ⌘⇧M / Ctrl+Shift+M shortcut ---------------------------------------
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

  // Open versions ↔ open comments: only one sidebar at a time (both pin
  // to the right rail). Toggling one closes the other.
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
      <div className="doc-toolbar flex items-center justify-between gap-3">
        <input
          className="doc-title flex-1"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
          placeholder="Untitled"
          autoComplete="off"
          spellCheck
        />
        <div className="flex items-center gap-2">
          <SaveVersionMenu
            docId={initialDoc.id}
            onSaved={() => setVersionsRefreshKey((k) => k + 1)}
          />
          <button
            type="button"
            onClick={openVersionsExclusive}
            className="text-sm px-3 py-1.5 rounded-md transition-colors"
            style={{
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-default)',
              background: versionsSidebarOpen ? 'var(--surface-selected)' : 'transparent',
            }}
            aria-pressed={versionsSidebarOpen}
          >
            Versions
          </button>
          <button
            type="button"
            onClick={openCommentsExclusive}
            className="text-sm px-3 py-1.5 rounded-md transition-colors flex items-center gap-2"
            style={{
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-default)',
              background: commentsSidebarOpen ? 'var(--surface-selected)' : 'transparent',
            }}
            aria-pressed={commentsSidebarOpen}
          >
            <span>Comments</span>
            {unresolvedCount > 0 && (
              <span
                className="text-xs px-1.5 rounded-full"
                style={{
                  background: 'var(--accent-400)',
                  color: 'var(--text-inverse)',
                }}
              >
                {unresolvedCount}
              </span>
            )}
          </button>
        </div>
      </div>
      <div className="relative">
        <Editor
          docId={initialDoc.id}
          initialMarkdown={initialDoc.markdown}
          jwt={jwt}
          user={user}
          onViewReady={setView}
          onSelectionChange={handleSelectionChange}
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
    </div>
  );
}
