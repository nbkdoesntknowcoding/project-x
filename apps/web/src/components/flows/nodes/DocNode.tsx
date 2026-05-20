import type { NodeProps } from '@xyflow/react';
import { FileText } from 'lucide-react';
import { NodeShell } from './NodeShell';

interface DocNodeData extends Record<string, unknown> {
  title: string;
  kind: 'doc';
  doc_id?: string;
  instruction?: string;
}

export function DocNode({ data, selected }: NodeProps) {
  const d = data as DocNodeData;
  return (
    <NodeShell
      indicatorColor="var(--text-secondary)"
      kindLabel="Doc"
      title={d.title}
      selected={selected}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <FileText size={11} className="text-[var(--text-tertiary)]" strokeWidth={1.75} />
        <span className="text-[11px] text-[var(--text-tertiary)] truncate">
          {d.doc_id ? d.doc_id.slice(0, 8) : 'No doc referenced'}
        </span>
      </div>
      {d.instruction && (
        <p className="text-[11px] leading-[1.5] text-[var(--text-secondary)] line-clamp-3 italic">
          {d.instruction}
        </p>
      )}
    </NodeShell>
  );
}
