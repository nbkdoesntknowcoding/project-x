// TODO: Claude Design — apply Mnema glassmorphism design system
// Background: var(--bg) #0a0a0a
// Cards: rgba(255,255,255,0.04) + backdrop-filter: blur(24px)
// See BOPPL_Context_Engine_Prompt_UI_Redesign_All_MCP_Panels for token system

import { type JSX, useState } from 'react';

interface AddTaskModalProps {
  onAdd: (title: string, description?: string, priority?: string) => Promise<void>;
  onClose: () => void;
}

const PRIORITIES = ['low', 'medium', 'high', 'critical'];

export function AddTaskModal({ onAdd, onClose }: AddTaskModalProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onAdd(title.trim(), description.trim() || undefined, priority);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: 24,
        width: 480,
        maxWidth: '90vw',
      }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>
          Add task to backlog
        </h2>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-muted)', marginBottom: 4 }}>
              Title *
            </label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title…"
              required
              style={{
                width: '100%', padding: '8px 10px', borderRadius: 6,
                background: 'var(--surface-2)', border: '1px solid var(--line)',
                color: 'var(--ink)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-muted)', marginBottom: 4 }}>
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description…"
              rows={3}
              style={{
                width: '100%', padding: '8px 10px', borderRadius: 6,
                background: 'var(--surface-2)', border: '1px solid var(--line)',
                color: 'var(--ink)', fontSize: 13, outline: 'none',
                resize: 'vertical', boxSizing: 'border-box',
              }}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-muted)', marginBottom: 4 }}>
              Priority
            </label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              style={{
                padding: '7px 10px', borderRadius: 6,
                background: 'var(--surface-2)', border: '1px solid var(--line)',
                color: 'var(--ink)', fontSize: 13, outline: 'none', cursor: 'pointer',
              }}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
              ))}
            </select>
          </div>

          {error && (
            <p style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>{error}</p>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '7px 14px', borderRadius: 6, border: '1px solid var(--line)',
                background: 'transparent', color: 'var(--ink-muted)', fontSize: 13, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              style={{
                padding: '7px 14px', borderRadius: 6, border: 'none',
                background: 'var(--accent)', color: '#fff',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
                opacity: submitting || !title.trim() ? 0.5 : 1,
              }}
            >
              {submitting ? 'Adding…' : 'Add task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
