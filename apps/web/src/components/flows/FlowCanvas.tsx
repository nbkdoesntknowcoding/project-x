import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type Connection,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { DocNode } from './nodes/DocNode';
import { DocsNode } from './nodes/DocsNode';
import { InstructionNode } from './nodes/InstructionNode';
import { DecisionNode } from './nodes/DecisionNode';
import { EditableEdge } from './edges/EditableEdge';
import { NodeInspector } from './NodeInspector';
import { FlowHeader, type SaveState } from './FlowHeader';
import { WalkSimulator } from './WalkSimulator';
import { DocSidebar } from './DocSidebar';
import { AddNodePalette } from './AddNodePalette';
import { VersionHistoryPanel } from './VersionHistoryPanel';
import { PublishModal } from './PublishModal';
import { detectCycle } from '../../lib/flows/cycle-detect';

export interface Flow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  published_version_id: string | null;
  draft_version_id: string;
  has_unpublished_changes: boolean;
  is_published: boolean;
  nodes: Array<{
    client_node_id: string;
    kind: 'doc' | 'docs' | 'instruction' | 'decision';
    title: string;
    position_x: number;
    position_y: number;
    data: Record<string, unknown>;
  }>;
  edges: Array<{
    from_node_id: string;
    to_node_id: string;
    from_socket: string;
  }>;
}

type NodeKind = 'doc' | 'docs' | 'instruction' | 'decision';

// ─── Adapters ────────────────────────────────────────────────────────────────

function mnemaNodeToRF(n: Flow['nodes'][number]): Node {
  return {
    id: n.client_node_id,
    type: n.kind,
    position: { x: n.position_x, y: n.position_y },
    data: { ...n.data, title: n.title, kind: n.kind },
    draggable: true,
    selectable: true,
    connectable: true,
    deletable: true,
  };
}

function rfNodeToMnema(n: Node): Flow['nodes'][number] {
  return {
    client_node_id: n.id,
    kind: n.data.kind as NodeKind,
    title: n.data.title as string,
    position_x: Math.round(n.position.x),
    position_y: Math.round(n.position.y),
    data: n.data as Record<string, unknown>,
  };
}

function rfEdgeToMnema(e: Edge): Flow['edges'][number] {
  return { from_node_id: e.source, to_node_id: e.target, from_socket: 'default' };
}

function makeClientNodeId(prefix: string, nodes: Node[]): string {
  const kebab = prefix.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const base = kebab || 'node';
  const existing = new Set(nodes.map((n) => n.id));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ─── Node / Edge types ───────────────────────────────────────────────────────

const nodeTypes: NodeTypes = {
  doc: DocNode,
  docs: DocsNode,
  instruction: InstructionNode,
  decision: DecisionNode,
};

const edgeTypes: EdgeTypes = {
  editable: EditableEdge,
};

// ─── Default data per kind ───────────────────────────────────────────────────

function defaultData(kind: NodeKind): Record<string, unknown> {
  switch (kind) {
    case 'doc':
      return { doc_id: null, instruction: '' };
    case 'docs':
      return { doc_ids: [], instruction: '' };
    case 'instruction':
      return { text: '' };
    case 'decision':
      return { condition: '', branches: {} };
  }
}

// ─── Inner canvas (needs ReactFlowProvider context) ──────────────────────────

interface InnerProps {
  flow: Flow;
}

function InnerCanvas({ flow }: InnerProps) {
  const initialNodes = useMemo(() => flow.nodes.map(mnemaNodeToRF), [flow.nodes]);
  const initialEdges = useMemo(
    () =>
      flow.edges.map((e, i) => ({
        id: `${e.from_node_id}__${e.to_node_id}__${e.from_socket}__${i}`,
        source: e.from_node_id,
        target: e.to_node_id,
        sourceHandle: e.from_socket,
        type: 'editable',
        animated: false,
        deletable: true,
      })),
    [flow.edges],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [walkMode, setWalkMode] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [isDirty, setIsDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(
    flow.has_unpublished_changes || !flow.is_published,
  );

  const rfInstance = useRef<{ getViewport: () => { x: number; y: number; zoom: number } } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);

  // Keep refs in sync
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // ─── Save logic ─────────────────────────────────────────────────────────

  const save = useCallback(async (currentNodes?: Node[], currentEdges?: Edge[]) => {
    const n = currentNodes ?? nodesRef.current;
    const e = currentEdges ?? edgesRef.current;
    setSaveState('saving');
    try {
      const res = await fetch(`/api/flows/${flow.id}/draft`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodes: n.map(rfNodeToMnema),
          edges: e.map(rfEdgeToMnema),
        }),
      });
      if (!res.ok) throw new Error('Save failed');
      setSaveState('saved');
      setLastSavedAt(new Date());
      setIsDirty(false);
      setHasUnpublishedChanges(true);
    } catch {
      setSaveState('error');
    }
  }, [flow.id]);

  const markDirty = useCallback(() => {
    setIsDirty(true);
    setSaveState('idle');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      save();
    }, 1500);
  }, [save]);

  // ─── Node change handlers ────────────────────────────────────────────────

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      const hasMeaningful = changes.some(
        (c) => c.type === 'position' || c.type === 'remove' || c.type === 'add',
      );
      if (hasMeaningful) markDirty();
    },
    [onNodesChange, markDirty],
  );

  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      if (changes.some((c) => c.type === 'remove' || c.type === 'add')) markDirty();
    },
    [onEdgesChange, markDirty],
  );

  // ─── Connect validation ──────────────────────────────────────────────────

  const handleConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target) return;
      // No self-edges
      if (source === target) return;
      // No duplicates
      const dup = edgesRef.current.some((e) => e.source === source && e.target === target);
      if (dup) return;
      // No cycles
      const tentative = [
        ...edgesRef.current.map((e) => ({ source: e.source, target: e.target })),
        { source, target },
      ];
      if (detectCycle(tentative)) {
        alert('This connection would create a cycle, which is not allowed in flows.');
        return;
      }
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: 'editable',
            animated: false,
            deletable: true,
          },
          eds,
        ),
      );
      markDirty();
    },
    [setEdges, markDirty],
  );

  // ─── Node add ───────────────────────────────────────────────────────────

  const handleAddNode = useCallback(
    (kind: NodeKind) => {
      const viewport = rfInstance.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 };
      const centerX = (-viewport.x + window.innerWidth / 2) / viewport.zoom;
      const centerY = (-viewport.y + window.innerHeight / 2) / viewport.zoom;
      const label =
        kind === 'doc' ? 'New Doc' :
        kind === 'docs' ? 'New Docs' :
        kind === 'instruction' ? 'New Instruction' :
        'New Decision';
      const id = makeClientNodeId(label, nodesRef.current);
      const newNode: Node = {
        id,
        type: kind,
        position: { x: centerX - 140, y: centerY - 60 },
        data: { ...defaultData(kind), title: label, kind },
        draggable: true,
        selectable: true,
        connectable: true,
        deletable: true,
      };
      setNodes((ns) => [...ns, newNode]);
      setSelectedNodeId(id);
      markDirty();
    },
    [setNodes, markDirty],
  );

  // ─── Drop from DocSidebar ────────────────────────────────────────────────

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData('application/mnema-doc');
      if (!raw) return;
      let doc: { id: string; title: string };
      try { doc = JSON.parse(raw); } catch { return; }

      const rfEl = document.querySelector('.react-flow') as HTMLElement | null;
      if (!rfEl) return;
      const bounds = rfEl.getBoundingClientRect();
      const viewport = rfInstance.current?.getViewport() ?? { x: 0, y: 0, zoom: 1 };
      const x = (event.clientX - bounds.left - viewport.x) / viewport.zoom;
      const y = (event.clientY - bounds.top - viewport.y) / viewport.zoom;

      const id = makeClientNodeId(doc.title, nodesRef.current);
      const newNode: Node = {
        id,
        type: 'doc',
        position: { x: x - 140, y: y - 40 },
        data: { doc_id: doc.id, doc_title: doc.title, title: doc.title, kind: 'doc', instruction: '' },
        draggable: true,
        selectable: true,
        connectable: true,
        deletable: true,
      };
      setNodes((ns) => [...ns, newNode]);
      setSelectedNodeId(id);
      markDirty();
    },
    [setNodes, markDirty],
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  // ─── Inspector update handlers ───────────────────────────────────────────

  const handleUpdateTitle = useCallback(
    (nodeId: string, title: string) => {
      setNodes((ns) =>
        ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, title } } : n)),
      );
      markDirty();
    },
    [setNodes, markDirty],
  );

  const handleUpdateData = useCallback(
    (nodeId: string, patch: Partial<Record<string, unknown>>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n,
        ),
      );
      markDirty();
    },
    [setNodes, markDirty],
  );

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
      markDirty();
    },
    [setNodes, setEdges, markDirty],
  );

  // ─── Selected node (live from nodes state) ───────────────────────────────

  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    const rfNode = nodes.find((n) => n.id === selectedNodeId);
    if (!rfNode) return null;
    return {
      client_node_id: rfNode.id,
      kind: rfNode.data.kind as NodeKind,
      title: rfNode.data.title as string,
      position_x: Math.round(rfNode.position.x),
      position_y: Math.round(rfNode.position.y),
      data: rfNode.data as Record<string, unknown>,
    };
  }, [nodes, selectedNodeId]);

  const handleNodeClick = useCallback((_: unknown, node: Node) => {
    setSelectedNodeId(node.id);
    setHistoryOpen(false);
  }, []);

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  // ─── History restore ─────────────────────────────────────────────────────

  const handleRestored = useCallback(() => {
    // Reload the page to get fresh data after a version restore
    window.location.reload();
  }, []);

  // ─── Publish ─────────────────────────────────────────────────────────────

  const handlePublished = useCallback(() => {
    setHasUnpublishedChanges(false);
    setIsDirty(false);
  }, []);

  return (
    <div className="h-[calc(100vh-48px)] flex">
      {/* Doc sidebar */}
      <DocSidebar />

      {/* Main canvas area */}
      <div className="flex-1 relative flex flex-col overflow-hidden">
        <FlowHeader
          flow={{ ...flow, has_unpublished_changes: hasUnpublishedChanges }}
          onWalkClick={() => setWalkMode(true)}
          saveState={saveState}
          isDirty={isDirty}
          onSaveNow={() => save()}
          lastSavedAt={lastSavedAt}
          hasUnpublishedChanges={hasUnpublishedChanges}
          historyOpen={historyOpen}
          onHistoryToggle={() => {
            setHistoryOpen((v) => !v);
            setSelectedNodeId(null);
          }}
          onPublishClick={() => setPublishOpen(true)}
        />

        {/* Add node palette — floats top-right of canvas */}
        <div className="absolute top-[70px] right-4 z-20">
          <AddNodePalette onAdd={handleAddNode} />
        </div>

        <div style={{ height: '100%', paddingTop: '56px' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
            onInit={(instance) => { rfInstance.current = { getViewport: () => instance.getViewport() }; }}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
            minZoom={0.3}
            maxZoom={2}
            nodesDraggable={true}
            nodesConnectable={true}
            elementsSelectable={true}
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{
              type: 'editable',
              animated: false,
              style: { stroke: 'var(--border-strong)', strokeWidth: 1.5 },
            }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={16}
              size={1}
              color="var(--border-subtle)"
            />
            <Controls position="bottom-left" showInteractive={false} />
            <MiniMap
              position="bottom-right"
              nodeColor={(node) => {
                switch (node.type) {
                  case 'doc':
                  case 'docs':
                    return 'var(--text-secondary)';
                  case 'instruction':
                    return 'var(--text-tertiary)';
                  case 'decision':
                    return 'var(--status-warning)';
                  default:
                    return 'var(--text-tertiary)';
                }
              }}
              maskColor="rgba(0,0,0,0.6)"
              pannable
              zoomable
            />
          </ReactFlow>
        </div>
      </div>

      {/* Right panels (mutually exclusive) */}
      {historyOpen && !selectedNodeId && (
        <VersionHistoryPanel
          flowId={flow.id}
          onClose={() => setHistoryOpen(false)}
          onRestored={handleRestored}
        />
      )}

      {selectedNode && !historyOpen && (
        <NodeInspector
          node={selectedNode}
          onClose={() => setSelectedNodeId(null)}
          onUpdateTitle={handleUpdateTitle}
          onUpdateData={handleUpdateData}
          onDeleteNode={handleDeleteNode}
        />
      )}

      {walkMode && (
        <WalkSimulator
          flowSlug={flow.slug}
          version={flow.is_published ? 'published' : 'draft'}
          onClose={() => setWalkMode(false)}
        />
      )}

      {publishOpen && (
        <PublishModal
          flowId={flow.id}
          onClose={() => setPublishOpen(false)}
          onPublished={handlePublished}
        />
      )}
    </div>
  );
}

// ─── Public export with provider ─────────────────────────────────────────────

interface Props {
  flow: Flow;
}

export function FlowCanvas({ flow }: Props) {
  return (
    <ReactFlowProvider>
      <InnerCanvas flow={flow} />
    </ReactFlowProvider>
  );
}
