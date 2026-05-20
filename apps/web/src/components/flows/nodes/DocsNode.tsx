import type { NodeProps } from '@xyflow/react';
import { Layers } from 'lucide-react';
import { NodeShell } from './NodeShell';

interface DocsNodeData extends Record<string, unknown> {
  title: string;
  kind: 'docs';
  doc_ids?: string[];
  filter?: Record<string, unknown>;
  instruction?: string;
}

export function DocsNode({ data, selected }: NodeProps) {
  const d = data as DocsNodeData;
  const summary = d.doc_ids
    ? `${d.doc_ids.length} doc${d.doc_ids.length === 1 ? '' : 's'}`
    : d.filter
      ? `filter: ${Object.entries(d.filter).map(([k, v]) => `${k}=${v}`).join(', ')}`
      : 'No docs';

  return (
    <NodeShell
      indicatorColor="var(--text-secondary)"
      kindLabel="Docs"
      title={d.title}
      selected={selected}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <Layers size={11} className="text-[var(--text-tertiary)]" strokeWidth={1.75} />
        <span className="text-[11px] text-[var(--text-tertiary)]">{summary}</span>
      </div>
      {d.instruction && (
        <p className="text-[11px] leading-[1.5] text-[var(--text-secondary)] line-clamp-3 italic">
          {d.instruction}
        </p>
      )}
    </NodeShell>
  );
}
