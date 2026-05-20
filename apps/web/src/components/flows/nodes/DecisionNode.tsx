import type { NodeProps } from '@xyflow/react';
import { GitBranch } from 'lucide-react';
import { NodeShell } from './NodeShell';

interface DecisionNodeData extends Record<string, unknown> {
  title: string;
  kind: 'decision';
  condition?: string;
  branches?: Record<string, string>;
}

export function DecisionNode({ data, selected }: NodeProps) {
  const d = data as DecisionNodeData;
  return (
    <NodeShell
      indicatorColor="var(--status-warning)"
      kindLabel="Decision"
      title={d.title}
      selected={selected}
    >
      <div className="flex items-start gap-1.5 mb-2">
        <GitBranch
          size={11}
          className="text-[var(--status-warning)] mt-0.5 shrink-0"
          strokeWidth={1.75}
        />
        <p className="text-[11px] leading-[1.5] text-[var(--text-secondary)] font-mono">
          {d.condition ?? (
            <span className="text-[var(--text-quaternary)]">No condition</span>
          )}
        </p>
      </div>
      <div className="text-[10px] font-mono uppercase tracking-[0.06em] text-[var(--text-quaternary)]">
        Branching ships in Phase 6.4
      </div>
    </NodeShell>
  );
}
