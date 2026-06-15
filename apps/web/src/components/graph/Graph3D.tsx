// apps/web/src/components/graph/Graph3D.tsx
'use client';
import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import ForceGraph2DLib from 'react-force-graph-2d';
import { forceRadial } from 'd3-force-3d';
// react-force-graph-2d's exported prop types are stricter than the runtime API.
// Cast to any so the documented props pass typecheck.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph2D = ForceGraph2DLib as any;
import { drawNode, getPointerArea } from './node-objects';
import { setHighlight, clearHighlight, highlightState } from './highlight';
import {
  generateStars, drawStars,
  generateBrainShell, drawBrainShell,
  type Star, type BrainPoint,
} from './environment';
import { NodeCard3D } from './NodeCard3D';
import { ENTITY_COLORS_CSS } from './constants';
import type { GraphNode, GraphEdge } from '../../lib/graph-types';

interface Props { nodes: GraphNode[]; edges: GraphEdge[]; }

export function Graph3D({ nodes, edges }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fg          = useRef<any>(null);
  const wrapRef     = useRef<HTMLDivElement>(null);
  const starsRef    = useRef<Star[]>([]);
  const shellRef    = useRef<BrainPoint[]>([]);
  const iTimer      = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [dims,    setDims]    = useState({ w: 0, h: 0 });
  const [selNode, setSelNode] = useState<GraphNode | null>(null);

  // ── Canvas sizing ───────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setDims({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Stars (generated once when dims are known) ──────────────────
  useEffect(() => {
    if (dims.w > 0 && starsRef.current.length === 0) {
      starsRef.current = generateStars(dims.w, dims.h);
    }
  }, [dims]);

  // ── Forces ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!fg.current) return;

    // Repulsion — pushes branches apart
    fg.current.d3Force('charge')?.strength(-80);

    // Tight link distance — branches stay bundled
    fg.current.d3Force('link')?.distance(() => 20).strength(1.0);

    // Radial force — hub nodes to centre, leaf nodes to periphery
    // This creates the dendritic branching structure
    fg.current.d3Force('radial', forceRadial(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) => {
        const deg = Math.min(node.degree ?? 0, 50);
        return (1 - deg / 50) * 200; // leaf node → 200 units out, hub → 0
      },
      0, 0,
    ).strength(0.4));

    // No z-layer force in 2D
    fg.current.d3Force('z-layer', null);
    fg.current.d3Force('confine', null);
  }, [nodes]);

  // ── Stable graphData ────────────────────────────────────────────
  const graphData = useMemo(() => ({
    nodes: nodes.map(n => ({ ...n, val: Math.max(n.degree ?? 1, 1) })),
    links: edges.map(e => ({
      ...e,
      source: e.fromNodeId,
      target: e.toNodeId,
      // Gentle random curvature — organic branch sweep
      curvature:         Math.random() * 0.2,
      curvatureRotation: Math.random() * Math.PI * 2,
    })),
  }), [nodes, edges]);

  // ── Node click ──────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onNodeClick = useCallback((raw: any) => {
    clearTimeout(iTimer.current);
    const node = raw as GraphNode;
    setSelNode(node);
    const conn = edges
      .filter(e => e.fromNodeId === node.id || e.toNodeId === node.id)
      .map(e => e.fromNodeId === node.id ? e.toNodeId : e.fromNodeId);
    setHighlight(node.id, conn);
  }, [edges]);

  const onBgClick = useCallback(() => {
    setSelNode(null);
    clearHighlight();
  }, []);

  // ── nodeCanvasObject — draws each node on the 2D canvas ─────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeCanvasObject = useCallback((node: any, ctx: CanvasRenderingContext2D) => {
    const n         = node as GraphNode;
    const selected  = highlightState.selectedId === n.id;
    const connected = highlightState.connectedIds.has(n.id);
    const any       = highlightState.selectedId !== null;
    drawNode(n, ctx, selected, connected, any);
  }, []);

  // ── nodePointerAreaPaint — defines click hit area ────────────────
  const nodePointerAreaPaint = useCallback((
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any,
    colour: string,
    ctx: CanvasRenderingContext2D,
  ) => {
    const n = node as GraphNode;
    ctx.fillStyle = colour;
    ctx.beginPath();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.arc((node as any).x ?? 0, (node as any).y ?? 0, getPointerArea(n), 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  // ── onRenderFramePre — draws stars + brain shell before nodes ────
  // This callback runs inside ForceGraph2D's own render loop (no extra RAF)
  const onRenderFramePre = useCallback((ctx: CanvasRenderingContext2D) => {
    // Draw background stars
    if (starsRef.current.length > 0) drawStars(ctx, starsRef.current);
    // Draw brain shell if computed
    if (shellRef.current.length > 0) drawBrainShell(ctx, shellRef.current);
  }, []);

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', width: '100%', height: '100%', background: '#000000' }}
    >
      {dims.w > 0 && (
        <ForceGraph2D
          ref={fg}
          width={dims.w}
          height={dims.h}
          graphData={graphData}
          backgroundColor="#000000"

          // ── Node rendering ────────────────────────────────────
          nodeCanvasObject={nodeCanvasObject}
          nodeCanvasObjectMode={() => 'replace'}  // our drawNode fully replaces default
          nodePointerAreaPaint={nodePointerAreaPaint}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nodeLabel={(n: any) => (n as GraphNode).label}

          // ── Link styling ──────────────────────────────────────
          // Source node's entity colour at full saturation
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkColor={(link: any) => {
            const src = link.source;
            const col = ENTITY_COLORS_CSS[src?.entityType] ?? '#ffffff';
            // Dim if something is selected and this link isn't connected
            if (highlightState.selectedId) {
              const sid = highlightState.selectedId;
              const fromId = src?.id ?? '';
              const toId   = link.target?.id ?? '';
              if (fromId !== sid && toId !== sid) return col.replace(')', ',0.05)').replace('rgb', 'rgba');
            }
            return col;
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkWidth={(link: any) => {
            const e = link as GraphEdge;
            if (e.provenance === 'AMBIGUOUS') return 0.4;
            if (e.provenance === 'INFERRED')  return 0.9;
            return 1.5;  // EXTRACTED: thin bright coloured line (not thick cylinder)
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          linkCurvature={(link: any) => link.curvature ?? 0}
          linkOpacity={0.9}

          // ── Simulation ────────────────────────────────────────
          // No cooldownTicks — natural alpha decay
          d3AlphaDecay={0.02}
          d3VelocityDecay={0.4}
          warmupTicks={80}

          onEngineStop={() => {
            // Compute brain shell from settled node positions
            const data = fg.current?.graphData();
            let maxR = 0, cx = 0, cy = 0;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data?.nodes?.forEach((n: any) => {
              const r = Math.sqrt((n.x ?? 0) ** 2 + (n.y ?? 0) ** 2);
              if (r > maxR) maxR = r;
              cx += (n.x ?? 0);
              cy += (n.y ?? 0);
            });
            const count = data?.nodes?.length ?? 1;
            cx /= count; cy /= count;

            if (maxR > 10) {
              shellRef.current = generateBrainShell(cx, cy, maxR);
              console.log(`[Graph2D] graphR=${maxR.toFixed(0)} shellR=${(maxR*1.5).toFixed(0)}`);
            }

            // Fit the view to show all nodes with padding
            fg.current?.zoomToFit(800, 60);
          }}

          // ── Background pass ───────────────────────────────────
          onRenderFramePre={onRenderFramePre}

          // ── Interaction ───────────────────────────────────────
          onNodeClick={onNodeClick}
          onBackgroundClick={onBgClick}
          showNavInfo={false}
          enableZoomInteraction={true}
          enablePanInteraction={true}
        />
      )}

      {selNode && (
        <NodeCard3D
          node={selNode}
          edges={edges}
          allNodes={nodes}
          fgRef={fg}
          onClose={onBgClick}
          onOpenNode={(id) => {
            const n = nodes.find(x => x.id === id);
            if (n) onNodeClick(n);
          }}
        />
      )}
    </div>
  );
}
