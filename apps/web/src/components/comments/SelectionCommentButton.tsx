import { type JSX, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from 'prosemirror-view';
import type { EditorSelection } from '../editor/Editor';

/**
 * Google-Docs-style floating "Comment" affordance. Appears just above a non-empty text
 * selection in the editor; clicking it opens the comment composer anchored to that selection.
 *
 * Before this, the ONLY way to start a comment was the hidden ⌘⇧M shortcut — so commenting
 * looked completely absent. This is the discoverable entry point.
 *
 * Positioning uses ProseMirror's viewport coords (view.coordsAtPos), portaled to <body> so it
 * isn't clipped by the editor's scroll container. onMouseDown preventDefault keeps the text
 * selection alive when the button is clicked (a normal click would collapse it and lose the anchor).
 */
export function SelectionCommentButton({
  view,
  selection,
  canComment,
  onAdd,
}: {
  view: EditorView | null;
  selection: EditorSelection | null;
  canComment: boolean;
  onAdd: (sel: EditorSelection) => void;
}): JSX.Element | null {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!view || !canComment || !selection || selection.from === selection.to) {
      setPos(null);
      return;
    }
    try {
      const start = view.coordsAtPos(selection.from);
      const end = view.coordsAtPos(selection.to);
      const top = Math.max(8, Math.min(start.top, end.top) - 40);
      const left = Math.max(8, end.left);
      setPos({ top, left });
    } catch {
      setPos(null);
    }
  }, [view, selection, canComment]);

  if (!pos || !selection) return null;

  return createPortal(
    <button
      type="button"
      // Preserve the selection: a plain click would blur the editor and collapse it, losing the anchor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onAdd(selection)}
      title="Comment on selection (⌘⇧M)"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 60,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 11px',
        borderRadius: 8,
        fontSize: 12.5,
        fontWeight: 600,
        color: 'var(--text-primary, #fafafa)',
        background: 'var(--surface-overlay, #24272d)',
        border: '1px solid var(--border-default, rgba(255,255,255,0.14))',
        boxShadow: '0 6px 20px -8px rgba(0,0,0,0.5)',
        cursor: 'pointer',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      Comment
    </button>,
    document.body,
  );
}
