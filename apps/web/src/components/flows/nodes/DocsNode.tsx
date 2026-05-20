import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';

interface DocsNodeData extends Record<string, unknown> {
  title: string;
  kind: 'docs';
  doc_ids?: string[];
  filter?: Record<string, unknown>;
  instruction?: string;
}

export function DocsNode({ data, selected, isConnectable }: NodeProps) {
  const d = data as DocsNodeData;
  const count = d.doc_ids?.length ?? 0;
  const summary = count > 0
    ? `${count} doc${count === 1 ? '' : 's'}`
    : d.filter
      ? `filter: ${Object.entries(d.filter).map(([k, v]) => `${k}=${v}`).join(', ')}`
      : null;

  return (
    <NodeShell
      indicatorColor="var(--ink-soft)"
      kindLabel="Docs"
      title={d.title}
      selected={selected}
      isConnectable={isConnectable}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '6px 9px',
          background: 'var(--surface-2)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          fontFamily: 'var(--sans)',
          fontSize: 11.5,
          fontWeight: 500,
          color: 'var(--ink)',
          marginBottom: d.instruction ? 8 : 0,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ color: 'var(--ink-muted)', flexShrink: 0 }}>
          <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/>
        </svg>
        <span style={{ color: summary ? 'var(--ink)' : 'var(--ink-muted)', fontStyle: summary ? 'normal' : 'italic' }}>
          {summary ?? 'No docs linked'}
        </span>
      </div>
      {d.instruction && (
        <div
          style={{
            fontFamily: 'var(--sans)',
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--ink-muted)',
            fontStyle: 'italic',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          "{d.instruction}"
        </div>
      )}
    </NodeShell>
  );
}
