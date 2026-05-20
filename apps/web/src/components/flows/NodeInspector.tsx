import { X, FileText, Layers, MessageSquare, GitBranch, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { MonoLabel } from '../ui/typography';
import { DocPicker } from './DocPicker';

interface FlowNode {
  client_node_id: string;
  kind: 'doc' | 'docs' | 'instruction' | 'decision';
  title: string;
  position_x: number;
  position_y: number;
  data: Record<string, unknown>;
}

interface Props {
  node: FlowNode;
  onClose: () => void;
  onUpdateTitle: (nodeId: string, title: string) => void;
  onUpdateData: (nodeId: string, data: Partial<Record<string, unknown>>) => void;
  onDeleteNode: (nodeId: string) => void;
}

export function NodeInspector({ node, onClose, onUpdateTitle, onUpdateData, onDeleteNode }: Props) {
  const handleDelete = () => {
    if (!confirm(`Delete node "${node.title}"? This cannot be undone.`)) return;
    onDeleteNode(node.client_node_id);
    onClose();
  };

  return (
    <aside className="w-[360px] h-full border-l border-[var(--line)] bg-[var(--surface)] flex flex-col" style={{ boxShadow: '-16px 0 40px -16px rgba(0,0,0,0.5)' }}>
      <div className="flex items-center justify-between px-5 h-14 border-b border-[var(--line)]">
        <div className="flex items-center gap-2">
          <KindIcon kind={node.kind} />
          <MonoLabel>{node.kind}</MonoLabel>
        </div>
        <button
          onClick={onClose}
          className="text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors"
          aria-label="Close inspector"
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Editable title */}
        <div>
          <MonoLabel className="block mb-1.5">Title</MonoLabel>
          <input
            type="text"
            value={node.title}
            onChange={(e) => onUpdateTitle(node.client_node_id, e.target.value)}
            className="w-full text-[15px] font-medium text-[var(--ink)] bg-transparent border border-transparent rounded-[var(--radius-sm)] px-1 py-0.5 -mx-1 focus:bg-[var(--canvas)] focus:border-[var(--line-bright)] outline-none transition-colors leading-[1.3]"
            placeholder="Node title"
          />
        </div>

        <div>
          <MonoLabel className="block mb-1.5">Node ID</MonoLabel>
          <code className="text-[12px] font-mono text-[var(--ink-soft)] bg-[var(--canvas)] px-2 py-1 rounded-[var(--radius-sm)]">
            {node.client_node_id}
          </code>
        </div>

        {node.kind === 'doc' && (
          <DocInspectorBody
            data={node.data}
            onChange={(patch) => onUpdateData(node.client_node_id, patch)}
          />
        )}
        {node.kind === 'docs' && (
          <DocsInspectorBody
            data={node.data}
            onChange={(patch) => onUpdateData(node.client_node_id, patch)}
          />
        )}
        {node.kind === 'instruction' && (
          <InstructionInspectorBody
            data={node.data}
            onChange={(patch) => onUpdateData(node.client_node_id, patch)}
          />
        )}
        {node.kind === 'decision' && (
          <DecisionInspectorBody
            data={node.data}
            onChange={(patch) => onUpdateData(node.client_node_id, patch)}
          />
        )}

        <div>
          <MonoLabel className="block mb-1.5">Canvas position</MonoLabel>
          <code className="text-[11px] font-mono text-[var(--ink-faint)]">
            x: {Math.round(node.position_x)}, y: {Math.round(node.position_y)}
          </code>
        </div>
      </div>

      <div className="border-t border-[var(--line)] px-5 py-3">
        <Button
          variant="danger"
          size="sm"
          className="w-full"
          onClick={handleDelete}
        >
          <Trash2 size={12} strokeWidth={1.75} />
          Delete this node
        </Button>
      </div>
    </aside>
  );
}

function KindIcon({ kind }: { kind: string }) {
  const cls = 'text-[var(--ink-soft)]';
  switch (kind) {
    case 'doc':
      return <FileText size={14} strokeWidth={1.75} className={cls} />;
    case 'docs':
      return <Layers size={14} strokeWidth={1.75} className={cls} />;
    case 'instruction':
      return <MessageSquare size={14} strokeWidth={1.75} className={cls} />;
    case 'decision':
      return <GitBranch size={14} strokeWidth={1.75} className="text-[var(--status-warning)]" />;
    default:
      return null;
  }
}

function DocInspectorBody({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const docId = typeof data.doc_id === 'string' ? data.doc_id : null;
  const instruction = typeof data.instruction === 'string' ? data.instruction : '';

  return (
    <>
      <div>
        <MonoLabel className="block mb-1.5">Doc reference</MonoLabel>
        <DocPicker
          value={docId}
          onChange={(id, title) => onChange({ doc_id: id ?? undefined, doc_title: title })}
        />
        {docId && (
          <a
            href={`/app/d/${docId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-1.5 text-[11px] text-[var(--ink-muted)] hover:text-[var(--ink-soft)] underline underline-offset-2"
          >
            Open doc →
          </a>
        )}
      </div>
      <div>
        <MonoLabel className="block mb-1.5">Instruction</MonoLabel>
        <textarea
          value={instruction}
          onChange={(e) => onChange({ instruction: e.target.value })}
          placeholder="What should Claude do with this doc?"
          rows={4}
          className="w-full px-2.5 py-2 text-[13px] bg-[var(--canvas)] border border-[var(--line)] rounded-[var(--radius-md)] text-[var(--ink)] placeholder:text-[var(--ink-faint)] outline-none focus:border-[var(--line-bright)] resize-none transition-colors leading-[1.6]"
        />
      </div>
    </>
  );
}

function DocsInspectorBody({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const docIds = Array.isArray(data.doc_ids) ? (data.doc_ids as string[]) : [];
  const instruction = typeof data.instruction === 'string' ? data.instruction : '';

  return (
    <>
      <div>
        <MonoLabel className="block mb-1.5">
          Doc references{' '}
          <span className="text-[var(--ink-faint)] font-normal">({docIds.length})</span>
        </MonoLabel>
        {docIds.length > 0 ? (
          <div className="space-y-1.5 mb-2">
            {docIds.map((id, i) => (
              <div key={id} className="flex items-center gap-2">
                <span className="flex-1 text-[12px] font-mono text-[var(--ink-soft)] bg-[var(--canvas)] px-2 py-1 rounded-[var(--radius-sm)] truncate">
                  {id.slice(0, 8)}…
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const next = [...docIds];
                    next.splice(i, 1);
                    onChange({ doc_ids: next });
                  }}
                  className="text-[var(--ink-faint)] hover:text-[var(--status-error)] transition-colors"
                  title="Remove"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-[var(--ink-faint)] italic mb-2">No docs linked</p>
        )}
        <DocPicker
          value={null}
          onChange={(id, _title) => {
            if (id && !docIds.includes(id)) {
              onChange({ doc_ids: [...docIds, id] });
            }
          }}
        />
        <p className="text-[11px] text-[var(--ink-faint)] mt-1">
          Use picker to add docs one at a time
        </p>
        {docIds.length > 0 && (
          <button
            type="button"
            onClick={() => onChange({ doc_ids: [] })}
            className="mt-1.5 text-[11px] text-[var(--status-error)] hover:underline"
          >
            Clear all
          </button>
        )}
      </div>
      <div>
        <MonoLabel className="block mb-1.5">Instruction</MonoLabel>
        <textarea
          value={instruction}
          onChange={(e) => onChange({ instruction: e.target.value })}
          placeholder="What should Claude do with these docs?"
          rows={4}
          className="w-full px-2.5 py-2 text-[13px] bg-[var(--canvas)] border border-[var(--line)] rounded-[var(--radius-md)] text-[var(--ink)] placeholder:text-[var(--ink-faint)] outline-none focus:border-[var(--line-bright)] resize-none transition-colors leading-[1.6]"
        />
      </div>
    </>
  );
}

function InstructionInspectorBody({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const text = typeof data.text === 'string' ? data.text : '';
  return (
    <div>
      <MonoLabel className="block mb-1.5">Text</MonoLabel>
      <textarea
        value={text}
        onChange={(e) => onChange({ text: e.target.value })}
        placeholder="Enter the instruction text for Claude…"
        rows={8}
        className="w-full px-2.5 py-2 text-[13px] bg-[var(--canvas)] border border-[var(--line)] rounded-[var(--radius-md)] text-[var(--ink)] placeholder:text-[var(--ink-faint)] outline-none focus:border-[var(--line-bright)] resize-none transition-colors leading-[1.65]"
      />
    </div>
  );
}

function DecisionInspectorBody({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const condition = typeof data.condition === 'string' ? data.condition : '';

  return (
    <>
      <div>
        <MonoLabel className="block mb-1.5">Condition</MonoLabel>
        <textarea
          value={condition}
          onChange={(e) => onChange({ condition: e.target.value })}
          placeholder="e.g. if context.urgency == 'high'"
          rows={4}
          className="w-full px-2.5 py-2 text-[12px] font-mono bg-[var(--canvas)] border border-[var(--line)] rounded-[var(--radius-md)] text-[var(--ink)] placeholder:text-[var(--ink-faint)] outline-none focus:border-[var(--line-bright)] resize-none transition-colors leading-[1.6]"
        />
      </div>
      <div className="border-t border-[var(--line)] pt-3">
        <MonoLabel className="text-[var(--status-warning)]">Note</MonoLabel>
        <p className="text-[12px] leading-[1.55] text-[var(--ink-muted)] mt-1">
          Decision routing ships in Phase 6.4. The condition field is editable but has no effect yet.
        </p>
      </div>
    </>
  );
}
