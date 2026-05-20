import type { NodeProps } from '@xyflow/react';
import { MessageSquare } from 'lucide-react';
import { NodeShell } from './NodeShell';

interface InstructionNodeData extends Record<string, unknown> {
  title: string;
  kind: 'instruction';
  text?: string;
}

export function InstructionNode({ data, selected }: NodeProps) {
  const d = data as InstructionNodeData;
  return (
    <NodeShell
      indicatorColor="var(--text-tertiary)"
      kindLabel="Instruction"
      title={d.title}
      selected={selected}
    >
      <div className="flex items-start gap-1.5">
        <MessageSquare
          size={11}
          className="text-[var(--text-tertiary)] mt-0.5 shrink-0"
          strokeWidth={1.75}
        />
        <p className="text-[11px] leading-[1.5] text-[var(--text-secondary)] line-clamp-4">
          {d.text ?? (
            <span className="italic text-[var(--text-quaternary)]">No text</span>
          )}
        </p>
      </div>
    </NodeShell>
  );
}
