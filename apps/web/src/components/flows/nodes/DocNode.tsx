import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';

interface DocNodeData extends Record<string, unknown> {
  title: string;
  kind: 'doc';
  doc_id?: string;
  doc_title?: string;
  instruction?: string;
}

export function DocNode({ data, selected, isConnectable }: NodeProps) {
  const d = data as DocNodeData;
  const docLabel = d.doc_title ?? (d.doc_id ? d.doc_id.slice(0, 8) + '…' : null);

  return (
    <NodeShell
      indicatorColor="var(--ink-soft)"
      kindLabel="Doc"
      title={d.title}
      selected={selected}
      isConnectable={isConnectable}
    >
      {docLabel && (
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
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <path d="M14 2v6h6"/>
          </svg>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {docLabel}
          </span>
        </div>
      )}
      {!docLabel && (
        <div style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--ink-muted)', fontStyle: 'italic' }}>
          No doc linked
        </div>
      )}
      {d.instruction && (
        <div
          style={{
            marginTop: 8,
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
