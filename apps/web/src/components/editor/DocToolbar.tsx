/**
 * DocToolbar — unified top bar that merges:
 *   LEFT  — block-type selector + formatting buttons (Bold / Italic / Code /
 *            Strikethrough / Bullet list / Ordered list / Blockquote)
 *   RIGHT — connection status · divider · Save version · Versions · Comments · divider · Share
 *
 * Re-renders whenever `selectionTick` changes (DocPage increments it on every
 * selection/state change), so active states stay in sync after each dispatch.
 */
import { toggleMark as pmToggleMark, lift, wrapIn } from 'prosemirror-commands';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import type { MarkType, NodeType } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import type { EditorState } from 'prosemirror-state';
import { type JSX, useEffect, useRef, useState } from 'react';
import type { HocuspocusProvider as HP } from '@hocuspocus/provider';
import { SaveVersionMenu } from '../versions/SaveVersionMenu';

// ─── state helpers ───────────────────────────────────────────────────────────

function isMarkActive(state: EditorState, markType: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) {
    const marks = state.storedMarks ?? $from.marks();
    return marks.some((m) => m.type === markType);
  }
  return state.doc.rangeHasMark(from, to, markType);
}

function activeBlockType(state: EditorState): string {
  const node = state.selection.$from.parent;
  if (node.type.name === 'heading') return `h${node.attrs.level as number}`;
  return 'paragraph';
}

function isListActive(state: EditorState, listTypeName: string): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === listTypeName) return true;
  }
  return false;
}

// ─── command helpers ─────────────────────────────────────────────────────────

function toggleMarkCmd(view: EditorView, markType: MarkType) {
  pmToggleMark(markType)(view.state, view.dispatch, view);
  view.focus();
}

function setBlockType(view: EditorView, typeName: string, attrs?: Record<string, unknown>) {
  const { state, dispatch } = view;
  const nodeType = state.schema.nodes[typeName] as NodeType | undefined;
  if (!nodeType) return;
  const { from, to } = state.selection;
  const tr = state.tr;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) tr.setBlockType(pos, pos + node.nodeSize, nodeType, attrs);
  });
  dispatch(tr);
  view.focus();
}

function toggleListCmd(view: EditorView, listTypeName: string) {
  const { state, dispatch } = view;
  const listType = state.schema.nodes[listTypeName] as NodeType | undefined;
  const itemType = state.schema.nodes['list_item'] as NodeType | undefined;
  if (!listType || !itemType) return;
  if (isListActive(state, listTypeName)) {
    liftListItem(itemType)(state, dispatch);
  } else {
    wrapInList(listType)(state, dispatch);
  }
  view.focus();
}

function toggleBlockquoteCmd(view: EditorView) {
  const { state, dispatch } = view;
  const bqType = state.schema.nodes['blockquote'] as NodeType | undefined;
  if (!bqType) return;
  const { from, to } = state.selection;
  let inBq = false;
  state.doc.nodesBetween(from, to, (node) => { if (node.type === bqType) inBq = true; });
  if (inBq) {
    lift(state, dispatch);
  } else {
    wrapIn(bqType)(state, dispatch);
  }
  view.focus();
}

// ─── tiny UI primitives ───────────────────────────────────────────────────────

function ToolBtn({
  active,
  title,
  disabled,
  onActivate,
  children,
}: {
  active?: boolean;
  title: string;
  disabled?: boolean;
  onActivate: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => {
        e.preventDefault();
        onActivate();
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        border: 'none',
        borderRadius: 4,
        background: active ? 'var(--surface-overlay)' : 'transparent',
        color: disabled ? 'var(--text-tertiary)' : active ? 'var(--text-primary)' : 'var(--text-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        fontSize: 13,
        fontWeight: 600,
        flexShrink: 0,
        transition: 'background 0.1s, color 0.1s',
      }}
    >
      {children}
    </button>
  );
}

function VSep(): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 1,
        height: 16,
        background: 'var(--border-default)',
        margin: '0 4px',
        flexShrink: 0,
      }}
    />
  );
}

// ─── block type selector dropdown ─────────────────────────────────────────────

const BLOCK_OPTIONS = [
  { value: 'paragraph', label: 'Paragraph', size: 12, weight: 400 },
  { value: 'h1', label: 'Heading 1', size: 14, weight: 700 },
  { value: 'h2', label: 'Heading 2', size: 13, weight: 600 },
  { value: 'h3', label: 'Heading 3', size: 12, weight: 600 },
  { value: 'h4', label: 'Heading 4', size: 12, weight: 500 },
];

function BlockTypeSelect({ view, current }: { view: EditorView; current: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const currentLabel = BLOCK_OPTIONS.find((o) => o.value === current)?.label ?? 'Text';

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 28,
          padding: '0 8px',
          border: 'none',
          borderRadius: 4,
          background: open ? 'var(--surface-overlay)' : 'transparent',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 500,
          whiteSpace: 'nowrap',
          flexShrink: 0,
          transition: 'background 0.1s',
          minWidth: 92,
        }}
      >
        {currentLabel}
        <svg width="9" height="5" viewBox="0 0 9 5" fill="none" style={{ flexShrink: 0 }}>
          <path d="M1 1l3.5 3L8 1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            background: 'var(--surface-overlay)',
            border: '1px solid var(--border-default)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            padding: 4,
            zIndex: 200,
            minWidth: 130,
          }}
        >
          {BLOCK_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setOpen(false);
                if (o.value === 'paragraph') {
                  setBlockType(view, 'paragraph');
                } else {
                  setBlockType(view, 'heading', { level: parseInt(o.value.slice(1), 10) });
                }
              }}
              style={{
                display: 'block',
                width: '100%',
                padding: '5px 10px',
                textAlign: 'left',
                background: current === o.value ? 'var(--interactive-ghost-hover)' : 'transparent',
                border: 'none',
                borderRadius: 4,
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontSize: o.size,
                fontWeight: o.weight,
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── connection pill ────────────────────────────────────────────────────────

function ConnectionPill({ provider }: { provider: HP | null }): JSX.Element {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'synced' | 'disconnected'>('connecting');

  useEffect(() => {
    if (!provider) return;
    const onStatus = ({ status: s }: { status: string }) => {
      if (s === 'connected') setStatus('connected');
      else if (s === 'disconnected') setStatus('disconnected');
    };
    const onSynced = () => setStatus('synced');
    provider.on('status', onStatus);
    provider.on('synced', onSynced);
    return () => {
      provider.off('status', onStatus);
      provider.off('synced', onSynced);
    };
  }, [provider]);

  const tone =
    status === 'synced' ? 'var(--status-success)' :
    status === 'disconnected' ? 'var(--status-error)' :
    'var(--text-tertiary)';

  const label =
    status === 'connecting' ? 'Connecting…' :
    status === 'connected' ? 'Connected' :
    status === 'synced' ? 'Synced' : 'Offline';

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 500, color: tone, flexShrink: 0 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: tone, display: 'inline-block', flexShrink: 0 }} />
      {label}
    </span>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

interface DocToolbarProps {
  view: EditorView | null;
  /** Increments whenever DocPage wants the toolbar to re-read view.state */
  selectionTick: number;
  provider: HP | null;
  docId: string;
  onSavedVersion: () => void;
  versionsSidebarOpen: boolean;
  onToggleVersions: () => void;
  commentsSidebarOpen: boolean;
  onToggleComments: () => void;
  unresolvedCount: number;
  onShare: () => void;
}

export function DocToolbar({
  view,
  selectionTick: _tick,   // consumed as dep to force re-render
  provider,
  docId,
  onSavedVersion,
  versionsSidebarOpen,
  onToggleVersions,
  commentsSidebarOpen,
  onToggleComments,
  unresolvedCount,
  onShare,
}: DocToolbarProps): JSX.Element {
  const state = view?.state ?? null;
  const schema = state?.schema;

  const boldMark   = schema?.marks['strong']     as MarkType | undefined;
  const italicMark = schema?.marks['emphasis']   as MarkType | undefined;
  const codeMark   = schema?.marks['inlineCode'] as MarkType | undefined;
  const strikeMark = schema?.marks['strike']     as MarkType | undefined;

  const isBold        = boldMark   && state ? isMarkActive(state, boldMark)   : false;
  const isItalic      = italicMark && state ? isMarkActive(state, italicMark) : false;
  const isCode        = codeMark   && state ? isMarkActive(state, codeMark)   : false;
  const isStrike      = strikeMark && state ? isMarkActive(state, strikeMark) : false;
  const isBulletList  = state ? isListActive(state, 'bullet_list')  : false;
  const isOrderedList = state ? isListActive(state, 'ordered_list') : false;
  const currentBlock  = state ? activeBlockType(state) : 'paragraph';
  const noView = !view;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 44,
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        padding: '0 12px',
        background: 'var(--surface-elevated)',
        borderBottom: '1px solid var(--border-default)',
        zIndex: 50,
        boxShadow: '0 1px 3px rgba(0,0,0,0.10)',
      }}
    >
      {/* ── Left: block type + formatting ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0, overflow: 'hidden' }}>

        {view ? (
          <BlockTypeSelect view={view} current={currentBlock} />
        ) : (
          <span style={{ width: 96, height: 28, display: 'inline-block', borderRadius: 4, background: 'var(--surface-base)' }} />
        )}

        <VSep />

        <ToolBtn active={isBold} title="Bold (⌘B)" disabled={noView} onActivate={() => boldMark && view && toggleMarkCmd(view, boldMark)}>
          <strong style={{ fontFamily: 'var(--font-sans)', fontSize: 13 }}>B</strong>
        </ToolBtn>

        <ToolBtn active={isItalic} title="Italic (⌘I)" disabled={noView} onActivate={() => italicMark && view && toggleMarkCmd(view, italicMark)}>
          <em style={{ fontFamily: 'Georgia, serif', fontSize: 14 }}>I</em>
        </ToolBtn>

        {strikeMark && (
          <ToolBtn active={isStrike} title="Strikethrough" disabled={noView} onActivate={() => strikeMark && view && toggleMarkCmd(view, strikeMark)}>
            <s style={{ fontSize: 12 }}>S</s>
          </ToolBtn>
        )}

        <ToolBtn active={isCode} title="Inline code" disabled={noView} onActivate={() => codeMark && view && toggleMarkCmd(view, codeMark)}>
          {/* code brackets icon */}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M4.5 3.5L1.5 7l3 3.5M9.5 3.5L12.5 7l-3 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </ToolBtn>

        <VSep />

        <ToolBtn active={isBulletList} title="Bullet list" disabled={noView} onActivate={() => view && toggleListCmd(view, 'bullet_list')}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="2.5" cy="4" r="1.1" fill="currentColor"/>
            <circle cx="2.5" cy="7" r="1.1" fill="currentColor"/>
            <circle cx="2.5" cy="10" r="1.1" fill="currentColor"/>
            <line x1="5.5" y1="4"  x2="12" y2="4"  stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <line x1="5.5" y1="7"  x2="12" y2="7"  stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <line x1="5.5" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </ToolBtn>

        <ToolBtn active={isOrderedList} title="Numbered list" disabled={noView} onActivate={() => view && toggleListCmd(view, 'ordered_list')}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <text x="0.5" y="5.5" style={{ fontSize: 5, fontFamily: 'monospace', fill: 'currentColor' }}>1.</text>
            <text x="0.5" y="8.5" style={{ fontSize: 5, fontFamily: 'monospace', fill: 'currentColor' }}>2.</text>
            <text x="0.5" y="11.5" style={{ fontSize: 5, fontFamily: 'monospace', fill: 'currentColor' }}>3.</text>
            <line x1="5.5" y1="4"  x2="12" y2="4"  stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <line x1="5.5" y1="7"  x2="12" y2="7"  stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <line x1="5.5" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </ToolBtn>

        <ToolBtn active={false} title="Blockquote" disabled={noView} onActivate={() => view && toggleBlockquoteCmd(view)}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="2" width="2" height="10" rx="1" fill="currentColor" opacity="0.65"/>
            <line x1="5" y1="5" x2="12" y2="5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <line x1="5" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <line x1="5" y1="9" x2="10" y2="9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </ToolBtn>
      </div>

      {/* ── Right: doc actions ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        <ConnectionPill provider={provider} />

        <VSep />

        <SaveVersionMenu docId={docId} onSaved={onSavedVersion} />

        <button
          type="button"
          onClick={onToggleVersions}
          style={{
            display: 'inline-flex', alignItems: 'center',
            height: 28, padding: '0 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
            fontSize: 12, fontWeight: 500,
            color: versionsSidebarOpen ? 'var(--text-primary)' : 'var(--text-secondary)',
            background: versionsSidebarOpen ? 'var(--surface-overlay)' : 'transparent',
            transition: 'background 0.1s',
          }}
          aria-pressed={versionsSidebarOpen}
        >
          Versions
        </button>

        <button
          type="button"
          onClick={onToggleComments}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            height: 28, padding: '0 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
            fontSize: 12, fontWeight: 500,
            color: commentsSidebarOpen ? 'var(--text-primary)' : 'var(--text-secondary)',
            background: commentsSidebarOpen ? 'var(--surface-overlay)' : 'transparent',
            transition: 'background 0.1s',
          }}
          aria-pressed={commentsSidebarOpen}
        >
          Comments
          {unresolvedCount > 0 && (
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 16, height: 16, borderRadius: '50%', fontSize: 10, fontWeight: 500,
                background: 'var(--status-info-bg)', color: 'var(--status-info)',
                border: '1px solid var(--status-info)',
              }}
            >
              {unresolvedCount}
            </span>
          )}
        </button>

        <VSep />

        <button
          type="button"
          onClick={onShare}
          style={{
            display: 'inline-flex', alignItems: 'center',
            height: 28, padding: '0 14px', borderRadius: 4, border: 'none', cursor: 'pointer',
            fontSize: 12, fontWeight: 600, color: '#fff',
            background: 'var(--accent-primary, #6366f1)',
          }}
        >
          Share
        </button>
      </div>
    </div>
  );
}
