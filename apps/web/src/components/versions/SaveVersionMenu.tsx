import { type JSX, useState } from 'react';

interface Props {
  docId: string;
  onSaved: () => void;
}

/**
 * Toolbar dropdown that lets the user name a manual snapshot of the
 * current doc. Sits next to the Versions toggle and shows the inline
 * input as a small popover when opened.
 *
 * Auto-snapshots happen every 50 store events under the hood (Phase 1.2
 * persistence), so this is for "name this milestone" use cases rather
 * than for routine saves.
 */
export function SaveVersionMenu({ docId, onSaved }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    if (!comment.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const apiUrl =
        (import.meta.env.PUBLIC_API_URL as string | undefined) ?? 'http://localhost:8080';
      const res = await fetch(`${apiUrl}/api/doc-versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ doc_id: docId, comment: comment.trim() }),
      });
      if (!res.ok) {
        setError(res.status === 403 ? 'Viewers cannot save versions.' : 'Save failed.');
        return;
      }
      setComment('');
      setOpen(false);
      onSaved();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm px-3 py-1.5 rounded-md transition-colors"
        style={{
          color: 'var(--text-secondary)',
          border: '1px solid var(--border-default)',
          background: open ? 'var(--surface-selected)' : 'transparent',
        }}
        aria-expanded={open}
      >
        Save version
      </button>
      {open && (
        <div
          className="absolute right-0 mt-2 w-72 p-3 rounded-md shadow-lg z-30"
          style={{
            background: 'var(--surface-overlay)',
            border: '1px solid var(--border-default)',
          }}
        >
          <label
            className="block text-xs mb-1.5"
            style={{ color: 'var(--text-tertiary)' }}
          >
            What changed?
          </label>
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
                setComment('');
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder="e.g. Initial draft"
            maxLength={200}
            className="w-full px-2 py-1.5 text-sm rounded-md focus:outline-none"
            style={{
              background: 'var(--surface-base)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-default)',
            }}
            autoFocus
          />
          {error && (
            <p className="mt-2 text-xs" style={{ color: 'var(--danger-default)' }}>
              {error}
            </p>
          )}
          <div className="mt-2 flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setComment('');
              }}
              className="px-3 py-1 text-xs"
              style={{ color: 'var(--text-secondary)' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !comment.trim()}
              className="px-3 py-1 text-xs rounded-md disabled:opacity-50"
              style={{
                background: 'var(--interactive-primary)',
                color: 'var(--text-inverse)',
              }}
            >
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
