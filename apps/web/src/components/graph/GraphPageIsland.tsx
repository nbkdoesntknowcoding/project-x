import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { NODE_COLORS_CSS, GOD_NODE_COLOR_CSS } from './graph-colors';
import type { GraphNode, GraphEdge, GraphCommunity, GraphData } from '../../lib/graph-types';

// Lazy-load the heavy 3D component so it doesn't block initial paint
const Graph3D = lazy(() => import('./Graph3D').then(m => ({ default: m.Graph3D })));

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  initialData: GraphData | null;
}

// ── Loading state ─────────────────────────────────────────────────────────────

function GraphLoadingState() {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: '#050508',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 16,
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
        textTransform: 'uppercase', letterSpacing: '0.08em',
        margin: 0,
      }}>Rendering knowledge graph</p>
      <style>{`
        @keyframes graphPulse {
          0%, 100% { transform: scale(1); opacity: 0.5; }
          50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 40px rgba(96,165,250,0.5); }
        }
      `}</style>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function GraphEmptyState({ onBuild }: { onBuild: () => void }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, background: '#050508',
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
        fontSize: 28, color: '#fafafa', margin: '0 0 8px',
        fontWeight: 400,
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

// ── Node detail drawer ────────────────────────────────────────────────────────

function NodeDetail({ node, onClose }: { node: GraphNode; onClose: () => void }) {
  const color = node.isGodNode ? GOD_NODE_COLOR_CSS : (NODE_COLORS_CSS[node.entityType] ?? '#888');
  return (
    <div style={{
      position: 'absolute', top: 0, right: 0, bottom: 0, width: 280,
      background: 'rgba(10,10,14,0.92)', backdropFilter: 'blur(20px)',
      border: '0.5px solid rgba(255,255,255,0.08)',
      padding: '18px 16px', overflowY: 'auto', zIndex: 30,
    }}>
      <button onClick={onClose} style={{
        position: 'absolute', top: 12, right: 12, background: 'none',
        border: 'none', color: '#52525b', cursor: 'pointer', fontSize: 16,
      }}>✕</button>

      <div style={{
        width: 10, height: 10, borderRadius: '50%',
        background: color,
        boxShadow: `0 0 8px ${color}`,
        marginBottom: 10,
      }} />
      <h3 style={{
        fontFamily: "'Instrument Serif', serif",
        fontSize: 16, color: '#fafafa', margin: '0 0 6px',
        fontWeight: 400, lineHeight: 1.4, paddingRight: 24,
      }}>{node.label}</h3>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{
          fontFamily: 'monospace', fontSize: 9.5, padding: '2px 6px',
          background: 'rgba(255,255,255,0.05)', border: '0.5px solid rgba(255,255,255,0.1)',
          borderRadius: 3, color: '#8a8f98', textTransform: 'uppercase', letterSpacing: '0.04em',
        }}>{node.entityType}</span>
        {node.isGodNode && (
          <span style={{
            fontFamily: 'monospace', fontSize: 9.5, padding: '2px 6px',
            background: 'rgba(255,191,36,0.12)', border: '0.5px solid rgba(255,191,36,0.25)',
            borderRadius: 3, color: '#fbbf24',
          }}>★ god-node</span>
        )}
      </div>

      {node.communityLabel && (
        <p style={{ fontSize: 11, color: '#52525b', margin: '0 0 10px', fontFamily: 'monospace' }}>
          ◆ {node.communityLabel}
        </p>
      )}

      <p style={{ fontSize: 11, color: '#52525b', margin: '0 0 8px', fontFamily: 'monospace', lineHeight: 1.8 }}>
        Degree: {node.degree ?? 0}{'  '}
        Betweenness: {(((node.betweennessCentrality ?? 0) * 100).toFixed(2))}%
      </p>

      {node.summary && (
        <p style={{ fontSize: 12, color: '#b8bcc4', lineHeight: 1.6, margin: 0 }}>{node.summary}</p>
      )}
    </div>
  );
}

// ── Main island ───────────────────────────────────────────────────────────────

export function GraphPageIsland({ initialData }: Props) {
  const [data,            setData]            = useState<GraphData | null>(initialData);
  const [loading,         setLoading]         = useState(!initialData);
  const [selectedNode,    setSelectedNode]    = useState<GraphNode | null>(null);
  const [buildStatus,     setBuildStatus]     = useState<'idle' | 'queuing' | 'queued'>('idle');
  const [hiddenTypes,     setHiddenTypes]     = useState<Set<string>>(new Set());
  const [godOnly,         setGodOnly]         = useState(false);
  const [searchQuery,     setSearchQuery]     = useState('');
  const [searchOpen,      setSearchOpen]      = useState(false);
  const [searchResults,   setSearchResults]   = useState<GraphNode[]>([]);
  const [traversalPath,   setTraversalPath]   = useState<string[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  // Container dimensions
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0]!.contentRect;
      setDims({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Client-side fetch fallback
  useEffect(() => {
    if (initialData) return;
    fetch('/api/graph/full', { credentials: 'include' })
      .then(r => r.ok ? r.json() as Promise<GraphData> : null)
      .then(d => { if (d) setData(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [initialData]);

  // SSE live updates
  useEffect(() => {
    const es = new EventSource('/api/notifications/stream', { withCredentials: true });
    es.addEventListener('graph_updated', () => {
      fetch('/api/graph/full', { credentials: 'include' })
        .then(r => r.ok ? r.json() as Promise<GraphData> : null)
        .then(d => { if (d) setData(d); })
        .catch(() => {});
    });
    return () => es.close();
  }, []);

  // Search
  useEffect(() => {
    if (!searchQuery.trim() || !data) { setSearchResults([]); return; }
    const q = searchQuery.toLowerCase();
    setSearchResults(data.nodes.filter(n => n.label?.toLowerCase().includes(q)).slice(0, 20));
  }, [searchQuery, data]);

  const handleBuild = useCallback(async () => {
    setBuildStatus('queuing');
    try {
      await fetch('/api/graph/build', { method: 'POST', credentials: 'include' });
      setBuildStatus('queued');
      setTimeout(() => setBuildStatus('idle'), 4000);
    } catch { setBuildStatus('idle'); }
  }, []);

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  const toggleType = useCallback((type: string) => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }, []);

  // Filtered data
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const communities = data?.communities ?? [];
  const report = data?.report;

  // LOD: cap at 800 nodes
  const displayNodes = nodes.length > 800
    ? nodes.sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0)).slice(0, 500)
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

  const entityTypes = ['doc', 'concept', 'decision', 'flow', 'task', 'project', 'rationale'];

  if (loading) return <GraphLoadingState />;
  if (!data || totalNodes === 0) return <GraphEmptyState onBuild={handleBuild} />;

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, background: '#050508', overflow: 'hidden' }}>

      {/* 3D canvas */}
      {dims.w > 0 && (
        <Suspense fallback={<GraphLoadingState />}>
          <Graph3D
            nodes={filteredNodes}
            edges={filteredEdges as GraphEdge[]}
            highlightedNodeIds={traversalPath}
            onNodeClick={handleNodeClick}
            onBackgroundClick={handleBackgroundClick}
            width={dims.w}
            height={dims.h}
          />
        </Suspense>
      )}

      {/* LOD notice */}
      {nodes.length > 800 && (
        <div style={{
          position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(10,10,14,0.8)', border: '0.5px solid rgba(255,255,255,0.08)',
          borderRadius: 6, padding: '4px 12px',
          fontFamily: 'monospace', fontSize: 10.5, color: '#52525b',
        }}>
          Showing top 500 of {nodes.length} nodes (by degree)
        </div>
      )}

      {/* Top-left: stats + filters */}
      <div style={{
        position: 'absolute', top: 14, left: 14, zIndex: 20,
        background: 'rgba(10,10,14,0.78)', backdropFilter: 'blur(14px)',
        border: '0.5px solid rgba(255,255,255,0.07)',
        borderRadius: 12, padding: '10px 14px', minWidth: 180,
      }}>
        <p style={{ fontFamily: 'monospace', fontSize: 10, color: '#52525b', margin: '0 0 10px', letterSpacing: '0.04em' }}>
          {filteredNodes.length} nodes · {filteredEdges.length} edges · {report?.godNodeCount ?? 0} god-nodes
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {entityTypes.map(type => (
            <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!hiddenTypes.has(type)}
                onChange={() => toggleType(type)}
                style={{ accentColor: NODE_COLORS_CSS[type] ?? '#888' }}
              />
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#8a8f98', fontFamily: 'monospace' }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: NODE_COLORS_CSS[type] ?? '#888',
                  boxShadow: `0 0 4px ${NODE_COLORS_CSS[type] ?? '#888'}`,
                  flexShrink: 0,
                }} />
                {type}
              </span>
            </label>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', marginTop: 4 }}>
            <input type="checkbox" checked={godOnly} onChange={e => setGodOnly(e.target.checked)} style={{ accentColor: '#fbbf24' }} />
            <span style={{ fontSize: 11, color: '#8a8f98', fontFamily: 'monospace' }}>★ god-nodes only</span>
          </label>
        </div>
      </div>

      {/* Top-right: search + build */}
      <div style={{ position: 'absolute', top: 14, right: 14, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
        {/* Search */}
        <div style={{ position: 'relative' }}>
          <input
            type="search"
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
            placeholder="Search nodes…"
            style={{
              width: 220, height: 34,
              background: 'rgba(10,10,14,0.82)', backdropFilter: 'blur(14px)',
              border: '0.5px solid rgba(255,255,255,0.1)',
              borderRadius: 8, padding: '0 12px',
              color: '#f4f5f7', fontFamily: 'monospace', fontSize: 12,
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
                    setSelectedNode(n);
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
                    background: n.isGodNode ? GOD_NODE_COLOR_CSS : (NODE_COLORS_CSS[n.entityType] ?? '#888'),
                  }} />
                  <span style={{ flex: 1, fontSize: 12, color: '#f4f5f7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {n.label}
                  </span>
                  <span style={{ fontSize: 10, color: '#52525b', fontFamily: 'monospace', flexShrink: 0 }}>{n.entityType}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Build button */}
        <button
          onClick={handleBuild}
          disabled={buildStatus !== 'idle'}
          style={{
            height: 32, padding: '0 14px', borderRadius: 8,
            background: buildStatus === 'queued' ? 'rgba(74,222,128,0.12)' : 'rgba(96,165,250,0.12)',
            border: buildStatus === 'queued' ? '0.5px solid rgba(74,222,128,0.3)' : '0.5px solid rgba(96,165,250,0.25)',
            color: buildStatus === 'queued' ? '#4ade80' : '#60a5fa',
            fontFamily: 'monospace', fontSize: 11, cursor: buildStatus === 'idle' ? 'pointer' : 'default',
            letterSpacing: '0.02em',
          }}
        >
          {buildStatus === 'idle' ? '↺ Rebuild' : buildStatus === 'queuing' ? 'Queuing…' : '✓ Queued'}
        </button>
      </div>

      {/* Node detail drawer */}
      {selectedNode && (
        <NodeDetail node={selectedNode} onClose={() => setSelectedNode(null)} />
      )}
    </div>
  );
}
