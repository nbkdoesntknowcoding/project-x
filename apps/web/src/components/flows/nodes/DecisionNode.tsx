import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';

interface DecisionNodeData extends Record<string, unknown> {
  title: string;
  kind: 'decision';
  condition?: string;
  branches?: Record<string, string>;
}

export function DecisionNode({ data, selected, isConnectable }: NodeProps) {
  const d = data as DecisionNodeData;
  return (
    <NodeShell
      indicatorColor="var(--status-edit)"
      kindLabel="Decision"
      title={d.title}
      selected={selected}
      isConnectable={isConnectable}
    >
      {d.condition ? (
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--ink)',
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: '8px 10px',
            marginBottom: 8,
          }}
        >
          <span style={{ color: 'var(--accent)' }}>if</span>{' '}
          {d.condition}
        </div>
      ) : null}
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          lineHeight: 1.4,
          color: 'var(--ink-muted)',
          letterSpacing: '0.02em',
          background: 'rgba(255,179,112,0.08)',
          border: '1px solid rgba(255,179,112,0.22)',
          borderRadius: 5,
          padding: '5px 8px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
        }}
      >
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--status-edit)', display: 'inline-block', flexShrink: 0 }} />
        BRANCHING SHIPS IN 6.4
      </div>
    </NodeShell>
  );
}
