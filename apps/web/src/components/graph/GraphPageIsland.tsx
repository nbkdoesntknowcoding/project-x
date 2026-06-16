import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { ENTITY_COLORS_CSS } from './constants';
import type { GraphNode, GraphEdge, GraphData } from '../../lib/graph-types';

const Graph3D = lazy(() => import('./Graph3D').then(m => ({ default: m.Graph3D })));

interface Props {
  initialData: GraphData | null;
}

function GraphLoadingState() {
  return (
    <div style={{
      position: 'absolute', inset: 0, background: '#000000',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16,
    }}>
      <div style={{
        width: 60, height: 60, borderRadius: '50%',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 0 20px rgba(96,165,250,0.3), 0 0 40px rgba(96,165,250,0.1)',
        animation: 'graphPulse 2s ease-in-out infinite',
      }} />
      <p style={{
        fontFamily: "'Geist Mono', monospace",
        fontSize: 11, color: '#52525b',
        textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0,
      }}>Rendering knowledge graph</p>
      <style>{`
        @keyframes graphPulse {
          0%, 100% { transform: scale(1); opacity: 0.5; }
          50% { transform: scale(1.3); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function GraphEmptyState({ onBuild }: { onBuild: () => void }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, background: '#000000',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 0,
    }}>
      <div style={{
        width: 80, height: 80, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(96,165,250,0.15) 0%, transparent 70%)',
        border: '1px solid rgba(96,165,250,0.2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 28, marginBottom: 20,
      }}>⑂</div>
      <h2 style={{
        fontFamily: "'Instrument Serif', Georgia, serif",
        fontSize: 28, color: '#fafafa', margin: '0 0 8px', fontWeight: 400,
      }}>Your knowledge graph is empty</h2>
      <p style={{ fontSize: 14, color: '#52525b', margin: '0 0 24px' }}>
        Build the graph to map the connections across your entire workspace.
      </p>
      <button onClick={onBuild} style={{
        height: 36, padding: '0 20px', borderRadius: 8,
        background: 'rgba(96,165,250,0.15)',
        border: '1px solid rgba(96,165,250,0.3)',
        color: '#60a5fa', fontFamily: 'var(--sans, sans-serif)',
        fontSize: 13, fontWeight: 500, cursor: 'pointer',
      }}>Build knowledge graph</button>
    </div>
  );
}

// Entity types + human-readable labels for the combined legend/filter panel.
const LEGEND_TYPES = ['doc','flow','flow_step','task','concept','decision','project','rationale','session'];
const LEGEND_LABELS: Record<string, string> = {
  doc: 'Document', flow: 'Workflow', flow_step: 'Workflow Step',
  task: 'Task', concept: 'Concept', decision: 'Decision',
  project: 'Project', rationale: 'Why Note', session: 'Agent Session',
};

// ── Main island ───────────────────────────────────────────────────────────────

export function GraphPageIsland({ initialData }: Props) {
  const [data,          setData]          = useState<GraphData | null>(initialData);
  const [loading,       setLoading]       = useState(!initialData);
  const [buildStatus,   setBuildStatus]   = useState<'idle' | 'queuing' | 'queued'>('idle');
  const [hiddenTypes,   setHiddenTypes]   = useState<Set<string>>(new Set());
  const [godOnly,       setGodOnly]       = useState(false);
  const [searchQuery,   setSearchQuery]   = useState('');
  const [searchOpen,    setSearchOpen]    = useState(false);
  const [searchResults, setSearchResults] = useState<GraphNode[]>([]);

  // Client-side fetch fallback
  useEffect(() => {
    if (initialData) return;
    fetch('/api/graph/full', { credentials: 'include' })
      .then(r => r.ok ? r.json() as Promise<GraphData> : null)
      .then(d => { if (d) setData(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [initialData]);

  // SSE: graph_updated → refetch; graph_node_added → forward to Graph3D
  useEffect(() => {
    const es = new EventSource('/api/notifications/stream', { withCredentials: true });

    es.addEventListener('graph_updated', () => {
      fetch('/api/graph/full', { credentials: 'include' })
        .then(r => r.ok ? r.json() as Promise<GraphData> : null)
        .then(d => { if (d) setData(d); })
        .catch(() => {});
    });

    es.addEventListener('graph_node_added', (e: MessageEvent) => {
      try {
        const detail = JSON.parse(e.data);
        window.dispatchEvent(new CustomEvent('mnema:graph_node_added', { detail }));
      } catch { /* malformed */ }
    });

    return () => es.close();
  }, []);

  // Search filter
  useEffect(() => {
    if (!searchQuery.trim() || !data) { setSearchResults([]); return; }
    const q = searchQuery.toLowerCase();
    setSearchResults(
      data.nodes.filter(n => n.label?.toLowerCase().includes(q)).slice(0, 20)
    );
  }, [searchQuery, data]);

  const handleBuild = useCallback(async () => {
    setBuildStatus('queuing');
    try {
      await fetch('/api/graph/build', { method: 'POST', credentials: 'include' });
      setBuildStatus('queued');
      setTimeout(() => setBuildStatus('idle'), 4000);
    } catch { setBuildStatus('idle'); }
  }, []);

  const toggleType = useCallback((type: string) => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }, []);

  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const report = data?.report;

  const displayNodes = nodes.length > 800
    ? [...nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0)).slice(0, 500)
    : nodes;

  const filteredNodes = displayNodes.filter(n => {
    if (hiddenTypes.has(n.entityType)) return false;
    if (godOnly && !n.isGodNode) return false;
    return true;
  });
  const filteredNodeIds = new Set(filteredNodes.map(n => n.id));
  const filteredEdges = edges.filter(e =>
    filteredNodeIds.has(e.fromNodeId) && filteredNodeIds.has(e.toNodeId)
  );

  const totalNodes = report?.totalNodes ?? nodes.length;

  if (loading) return <GraphLoadingState />;
  if (!data || totalNodes === 0) return <GraphEmptyState onBuild={handleBuild} />;

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#000000', overflow: 'hidden' }}>

      <Suspense fallback={<GraphLoadingState />}>
        <Graph3D nodes={filteredNodes} edges={filteredEdges as GraphEdge[]} />
      </Suspense>

      {/* Stats + type filters — top left.
          pointerEvents:'none' so the panel never blocks clicks on graph nodes
          behind it; only the actual controls (labels) re-enable pointer events. */}
      <div style={{
        position: 'absolute', top: 14, left: 14, zIndex: 20, pointerEvents: 'none',
        background: 'rgba(10,10,10,0.82)', backdropFilter: 'blur(14px)',
        border: '0.5px solid rgba(255,255,255,0.07)',
        borderRadius: 12, padding: '10px 14px', minWidth: 180,
      }}>
        <p style={{
          fontFamily: "'Geist Mono', monospace", fontSize: 10,
          color: '#52525b', margin: '0 0 10px', letterSpacing: '0.04em',
        }}>
          {filteredNodes.length} nodes · {filteredEdges.length} edges · {report?.godNodeCount ?? 0} god-nodes
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* Combined legend + filter: colour swatch (matches the node colour)
              + human-readable label, and the checkbox toggles visibility. */}
          {LEGEND_TYPES.map(type => (
            <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', pointerEvents: 'auto' }}>
              <input
                type="checkbox"
                checked={!hiddenTypes.has(type)}
                onChange={() => toggleType(type)}
                style={{ accentColor: ENTITY_COLORS_CSS[type] ?? '#888' }}
              />
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#c9ccd1', fontFamily: 'var(--sans)' }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: ENTITY_COLORS_CSS[type] ?? '#888',
                  boxShadow: `0 0 5px ${ENTITY_COLORS_CSS[type] ?? '#888'}`,
                  flexShrink: 0,
                }} />
                {LEGEND_LABELS[type] ?? type}
              </span>
            </label>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', marginTop: 4, pointerEvents: 'auto' }}>
            <input type="checkbox" checked={godOnly} onChange={e => setGodOnly(e.target.checked)} style={{ accentColor: '#fbbf24' }} />
            <span style={{ fontSize: 11, color: '#8a8f98', fontFamily: "'Geist Mono', monospace" }}>· god-nodes only</span>
          </label>
        </div>
      </div>

      {/* Search + build — top right. Same click-through treatment: the wrapper
          doesn't block graph clicks; the input/results/button re-enable them. */}
      <div style={{
        position: 'absolute', top: 14, right: 14, zIndex: 20, pointerEvents: 'none',
        display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end',
      }}>
        <div style={{ position: 'relative', pointerEvents: 'auto' }}>
          <input
            type="search"
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
            placeholder="Search nodes…"
            style={{
              width: 220, height: 34,
              background: 'rgba(10,10,10,0.82)', backdropFilter: 'blur(14px)',
              border: '0.5px solid rgba(255,255,255,0.1)',
              borderRadius: 8, padding: '0 12px',
              color: '#f4f5f7', fontFamily: "'Geist Mono', monospace", fontSize: 12,
              outline: 'none',
            }}
          />
          {searchOpen && searchResults.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, marginTop: 4,
              width: 280, maxHeight: 260, overflowY: 'auto',
              background: 'rgba(8,8,12,0.96)', backdropFilter: 'blur(20px)',
              border: '0.5px solid rgba(255,255,255,0.08)',
              borderRadius: 8, zIndex: 50,
            }}>
              {searchResults.map(n => (
                <div
                  key={n.id}
                  onMouseDown={() => {
                    // Zoom graph to this node
                    window.dispatchEvent(new CustomEvent('mnema:focus_node', { detail: { nodeId: n.id } }));
                    setSearchQuery('');
                    setSearchOpen(false);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 12px', cursor: 'pointer',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                    background: ENTITY_COLORS_CSS[n.entityType] ?? '#888',
                  }} />
                  <span style={{
                    flex: 1, fontSize: 12, color: '#f4f5f7',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{n.label}</span>
                  <span style={{ fontSize: 10, color: '#52525b', fontFamily: "'Geist Mono', monospace", flexShrink: 0 }}>
                    {n.entityType}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={handleBuild}
          disabled={buildStatus !== 'idle'}
          style={{
            pointerEvents: 'auto',
            height: 32, padding: '0 14px', borderRadius: 8,
            background: buildStatus === 'queued' ? 'rgba(74,222,128,0.12)' : 'rgba(96,165,250,0.12)',
            border: buildStatus === 'queued' ? '0.5px solid rgba(74,222,128,0.3)' : '0.5px solid rgba(96,165,250,0.25)',
            color: buildStatus === 'queued' ? '#4ade80' : '#60a5fa',
            fontFamily: "'Geist Mono', monospace", fontSize: 11,
            cursor: buildStatus === 'idle' ? 'pointer' : 'default',
            letterSpacing: '0.02em',
          }}
        >
          {buildStatus === 'idle' ? '↺ Rebuild' : buildStatus === 'queuing' ? 'Queuing…' : '✓ Queued'}
        </button>
      </div>

      {nodes.length > 800 && (
        <div style={{
          position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(10,10,10,0.8)', border: '0.5px solid rgba(255,255,255,0.08)',
          borderRadius: 6, padding: '4px 12px',
          fontFamily: "'Geist Mono', monospace", fontSize: 10.5, color: '#52525b',
        }}>
          Showing top 500 of {nodes.length} nodes (by degree)
        </div>
      )}
    </div>
  );
}
