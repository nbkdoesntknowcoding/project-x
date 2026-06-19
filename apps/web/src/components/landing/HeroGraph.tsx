'use client';
/**
 * HeroGraph — the landing hero graph, rendered with the SAME primitives as the
 * real /app/graph (drawNode glow nodes, entity colours, curved hair-thin links,
 * starfield + brain-shell background, radial dendritic force) so it mirrors the
 * actual product. Tuned for a hero: pan/zoom disabled (so the page still scrolls),
 * auto-framed, with amber "context tokens" travelling edges. Honors
 * prefers-reduced-motion and pauses offscreen / when the tab is hidden.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2DLib from 'react-force-graph-2d';
import { forceRadial } from 'd3-force-3d';
import { drawNode, getPointerArea } from '../graph/node-objects';
import { ENTITY_COLORS_CSS } from '../graph/constants';
import {
  generateStars,
  drawStars,
  generateBrainShell,
  drawBrainShell,
  type Star,
  type BrainPoint,
} from '../graph/environment';
import { HERO_EDGES, HERO_NODES } from './sample-graph';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph2D = ForceGraph2DLib as any;

// Hand-placed, balanced layout centered on (0,0): two project hubs left/right,
// their docs/flows/concepts around them, bridged in the middle. Deterministic —
// pinned so the hero never drifts or settles off-center.
const POS: Record<string, { x: number; y: number }> = {
  p_mnema: { x: -158, y: -6 },
  d_arch: { x: -262, y: -86 },
  d_mcp: { x: -288, y: 14 },
  d_onboard: { x: -232, y: 92 },
  d_pricing: { x: -136, y: 116 },
  f_onboard: { x: -96, y: 54 },
  c_context: { x: -34, y: -42 },
  c_graph: { x: -78, y: -116 },
  t_build: { x: -188, y: 150 },
  p_voice: { x: 158, y: -6 },
  d_latency: { x: 262, y: -84 },
  d_recall: { x: 290, y: 16 },
  c_stt: { x: 226, y: 96 },
  f_release: { x: 110, y: 70 },
  x_vad: { x: 210, y: -92 },
  t_review: { x: 150, y: 132 },
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

export default function HeroGraph() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fg = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const starsRef = useRef<Star[]>([]);
  const shellRef = useRef<BrainPoint[]>([]);
  const reduced = useRef(false);
  const visible = useRef(true);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  // Stable graphData in the real graph's shape (val = degree, curved links).
  const graphData = useMemo(
    () => ({
      // All nodes pinned to the hand-placed layout (fx/fy) — deterministic + centered.
      nodes: HERO_NODES.map((n) => {
        const p = POS[n.id] ?? { x: 0, y: 0 };
        return { ...n, val: Math.max(n.degree ?? 1, 1), x: p.x, y: p.y, fx: p.x, fy: p.y };
      }),
      links: HERO_EDGES.map((edge, i) => ({
        ...edge,
        source: edge.fromNodeId,
        target: edge.toNodeId,
        // deterministic gentle curvature (no Date/random in module scope issues)
        curvature: ((i % 7) - 3) * 0.08,
      })),
    }),
    [],
  );

  // ── sizing ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    reduced.current = prefersReducedMotion();
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setDims({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (dims.w > 0 && starsRef.current.length === 0) {
      starsRef.current = generateStars(dims.w, dims.h);
    }
  }, [dims]);

  // Nodes are pinned to a known, centered layout — just center the camera on the
  // origin with a fixed zoom that fits the composition (≈±300 x, ±150 y).
  useEffect(() => {
    if (dims.w === 0) return;
    const frame = () => {
      const inst = fg.current;
      if (!inst) return;
      // Nodes are static (pinned) so the bounding box is stable — zoomToFit
      // reliably centers + zooms to it.
      inst.zoomToFit?.(0, 64);
      const z = inst.zoom?.();
      if (typeof z === 'number' && z > 1.45) inst.zoom?.(1.45, 0);
    };
    const timers = [120, 600, 1400].map((d) => setTimeout(frame, d));
    return () => timers.forEach(clearTimeout);
  }, [dims.w, dims.h]);

  // ── forces — same dendritic/radial setup as the real graph ──────────────────
  useEffect(() => {
    const inst = fg.current;
    if (!inst) return;
    inst.d3Force('charge')?.strength(-90);
    inst.d3Force('link')?.distance(() => 26).strength(1);
    inst.d3Force(
      'radial',
      forceRadial(
        // Normalize by THIS graph's degree range (≈1–7) so hubs (projects) pull
        // to the centre and leaves to the periphery — the dendritic app look.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (node: any) => {
          const deg = Math.min(node.degree ?? 0, 8);
          return (1 - deg / 8) * 200;
        },
        0,
        0,
      ).strength(0.5),
    );
  }, [dims.w]);

  // ── context tokens travelling edges ─────────────────────────────────────────
  useEffect(() => {
    if (reduced.current) return;
    const id = setInterval(() => {
      const inst = fg.current;
      if (!inst || !visible.current || document.hidden) return;
      const link = graphData.links[Math.floor(Math.random() * graphData.links.length)];
      if (link) inst.emitParticle?.(link);
    }, 850);
    return () => clearInterval(id);
  }, [graphData]);

  // ── pause offscreen / hidden ────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        visible.current = entry?.isIntersecting ?? true;
        const inst = fg.current;
        if (!inst) return;
        if (visible.current) inst.resumeAnimation?.();
        else inst.pauseAnimation?.();
      },
      { threshold: 0.05 },
    );
    io.observe(el);
    const onVis = () => {
      const inst = fg.current;
      if (!inst) return;
      if (document.hidden) inst.pauseAnimation?.();
      else if (visible.current) inst.resumeAnimation?.();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // ── draw passes (identical primitives to the real graph) ────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeCanvasObject = useCallback((node: any, ctx: CanvasRenderingContext2D) => {
    drawNode(node, ctx, false, false, false);
  }, []);

  const nodePointerAreaPaint = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node: any, colour: string, ctx: CanvasRenderingContext2D) => {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, getPointerArea(node), 0, 2 * Math.PI);
      ctx.fill();
    },
    [],
  );

  const onRenderFramePre = useCallback((ctx: CanvasRenderingContext2D) => {
    if (starsRef.current.length > 0) drawStars(ctx, starsRef.current);
    if (shellRef.current.length > 0) drawBrainShell(ctx, shellRef.current);
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeLabel = useCallback((n: any) => n.label as string, []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linkColor = useCallback(
    (link: any) => ENTITY_COLORS_CSS[link.source?.entityType] ?? '#ffffff',
    [],
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linkWidth = useCallback((link: any) => {
    if (link.provenance === 'AMBIGUOUS') return 0.25;
    if (link.provenance === 'INFERRED') return 0.55;
    return 1;
  }, []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linkCurvature = useCallback((link: any) => link.curvature ?? 0, []);

  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    >
      {dims.w > 0 && (
        <ForceGraph2D
          ref={fg}
          width={dims.w}
          height={dims.h}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          nodeCanvasObject={nodeCanvasObject}
          nodePointerAreaPaint={nodePointerAreaPaint}
          nodeLabel={nodeLabel}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkCurvature={linkCurvature}
          linkOpacity={0.85}
          linkDirectionalParticleColor={() => '#FFB370'}
          linkDirectionalParticleWidth={2}
          linkDirectionalParticleSpeed={0.012}
          d3AlphaDecay={0.022}
          d3VelocityDecay={0.4}
          warmupTicks={reduced.current ? 120 : 80}
          autoPauseRedraw={false}
          enableNodeDrag={true}
          enableZoomInteraction={false}
          enablePanInteraction={false}
          showNavInfo={false}
          onRenderFramePre={onRenderFramePre}
          onEngineStop={() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ns = graphData.nodes as any[];
            let maxR = 0;
            let cx = 0;
            let cy = 0;
            ns.forEach((n) => {
              const r = Math.sqrt((n.x ?? 0) ** 2 + (n.y ?? 0) ** 2);
              if (r > maxR) maxR = r;
              cx += n.x ?? 0;
              cy += n.y ?? 0;
            });
            const count = ns.length || 1;
            cx /= count;
            cy /= count;
            if (maxR > 10) shellRef.current = generateBrainShell(cx, cy, maxR);
            // Framing is handled by the timed re-fit effect (runs as it settles).
            void cx;
            void cy;
          }}
        />
      )}
    </div>
  );
}
