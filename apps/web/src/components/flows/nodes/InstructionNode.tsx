import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';

interface InstructionNodeData extends Record<string, unknown> {
  title: string;
  kind: 'instruction';
  text?: string;
}

export function InstructionNode({ data, selected, isConnectable }: NodeProps) {
  const d = data as InstructionNodeData;
  return (
    <NodeShell
      indicatorColor="var(--ink-faint)"
      kindLabel="Instruction"
      title={d.title}
      selected={selected}
      isConnectable={isConnectable}
    >
      <div
        style={{
          fontFamily: 'var(--sans)',
          fontSize: 12,
          lineHeight: 1.5,
          color: 'var(--ink-soft)',
          display: '-webkit-box',
          WebkitLineClamp: 4,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {d.text ?? (
          <span style={{ color: 'var(--ink-faint)', fontStyle: 'italic' }}>No text</span>
        )}
      </div>
    </NodeShell>
  );
}
