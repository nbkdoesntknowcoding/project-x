'use client';
import { useRef, useCallback, useEffect, useState } from 'react';
import ForceGraph3DLib from 'react-force-graph-3d';
import { forceRadial } from 'd3-force-3d';
import * as THREE from 'three';
// react-force-graph-3d's exported prop types are stricter than the runtime API
// (e.g. linkCurveRotation). Cast to any so the documented props pass typecheck.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph3D = ForceGraph3DLib as any;
import { createNodeObject, clearNodeCache } from './node-objects';
import { setHighlight, clearHighlight } from './highlight';
import { setupBlackEnvironment, createStarField, createBrainBoundaryShell } from './environment';
import { ENTITY_COLORS_CSS } from './constants';
import { NodeCard3D } from './NodeCard3D';
import type { GraphNode, GraphEdge } from '../../lib/graph-types';

interface Props { nodes: GraphNode[]; edges: GraphEdge[]; }

export function Graph3D({ nodes, edges }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fg       = useRef<any>(null);
  const groups   = useRef(new Map<string, THREE.Group>());
  const shellRef = useRef<THREE.Points | null>(null);

  const [selNode, setSelNode] = useState<GraphNode | null>(null);
  const [cam,  setCam]  = useState<THREE.Camera | null>(null);
  const [cvs,  setCvs]  = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!fg.current) return;
    clearNodeCache(); groups.current.clear();
    const renderer = fg.current.renderer() as THREE.WebGLRenderer;
    const scene    = fg.current.scene()    as THREE.Scene;
    setupBlackEnvironment(renderer, scene);
    scene.add(createStarField());
    setCam(fg.current.camera());
    setCvs(renderer.domElement);
  }, []);

  // ── FORCES — dendritic neuron layout ──────────────────────────────
  useEffect(() => {
    if (!fg.current) return;

    // Strong repulsion — spreads branches far from each other
    fg.current.d3Force('charge')?.strength(-80);

    // Tight link distance — keeps each branch chain close together
    fg.current.d3Force('link')?.distance(() => 20).strength(1.0);

    // Radial force — the dendrite engine.
    // High-degree hub nodes → centre. Low-degree leaf nodes → periphery.
    fg.current.d3Force('radial', forceRadial(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) => {
        const deg = Math.min(node.degree ?? 0, 50);
        return (1 - deg / 50) * 200;
      },
      0, 0, 0,
    ).strength(0.4));

    // Z-layer: spread communities across depth planes for a 3D feel
    fg.current.d3Force('z-layer', (alpha: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes.forEach((n: any) => {
        const tz = ((n.communityId ?? 0) % 5) * 25 - 50;
        n.vz = (n.vz ?? 0) + (tz - (n.z ?? 0)) * 0.005 * alpha;
      });
    });

    // Remove the confinement force — radial force handles positioning now.
    // Confinement and radial fight each other.
    fg.current.d3Force('confine', null);
  }, [nodes]);

  // ── New-node entrance (event-driven only, not ambient motion) ─────
  useEffect(() => {
    const h = (e: Event) => {
      const { nodeId } = (e as CustomEvent).detail as { nodeId: string };
      setTimeout(() => {
        const g = groups.current.get(nodeId);
        if (!g) return;
        g.scale.setScalar(0);
        const s0 = performance.now();
        const grow = () => {
          const p = Math.min((performance.now() - s0) / 1200, 1);
          g.scale.setScalar(Math.max(0, 1 + 1.7 * Math.pow(p - 1, 3) + 1.7 * Math.pow(p - 1, 2)));
          if (p < 1) requestAnimationFrame(grow);
        };
        requestAnimationFrame(grow);
      }, 300);
    };
    window.addEventListener('mnema:graph_node_added', h);
    return () => window.removeEventListener('mnema:graph_node_added', h);
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onNodeClick = useCallback((raw: any) => {
    const node = raw as GraphNode;
    setSelNode(node);
    const conn = edges.filter(e => e.fromNodeId === node.id || e.toNodeId === node.id).map(e => e.fromNodeId === node.id ? e.toNodeId : e.fromNodeId);
    setHighlight(node.id, conn, groups.current);
    const h = Math.hypot(raw.x ?? 0, raw.y ?? 0, raw.z ?? 0);
    if (h > 0) {
      const ratio = 1 + 160 / h;
      fg.current?.cameraPosition({ x: (raw.x ?? 0) * ratio, y: (raw.y ?? 0) * ratio, z: (raw.z ?? 0) * ratio }, { x: raw.x ?? 0, y: raw.y ?? 0, z: raw.z ?? 0 }, 900);
    }
  }, [edges]);

  const onBgClick = useCallback(() => {
    setSelNode(null); clearHighlight(groups.current);
    groups.current.forEach(g => g.scale.setScalar(1));
  }, []);

  return (
    <div style={{ position:'relative', width:'100%', height:'100%' }}>
      <ForceGraph3D
        ref={fg}
        graphData={{
          nodes: nodes.map(n => ({ ...n, val: Math.max(n.degree ?? 1, 1) })),
          links: edges.map(e => ({
            ...e,
            source: e.fromNodeId,
            target: e.toNodeId,
            curvature: Math.random() * 0.25,
            curvatureRotation: Math.random() * Math.PI * 2,
          })),
        }}
        backgroundColor="#000000"
        nodeThreeObject={(n: object) => { const g=createNodeObject(n as GraphNode); groups.current.set((n as GraphNode).id,g); return g; }}
        nodeThreeObjectExtend={false}
        nodeLabel={(n: object) => (n as GraphNode).label}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        linkColor={(link: object) => { const src = (link as any).source; return ENTITY_COLORS_CSS[src?.entityType] ?? '#ffffff'; }}
        linkWidth={(link: object) => { const e=link as GraphEdge; if(e.provenance==='AMBIGUOUS') return 0.3; if(e.provenance==='INFERRED') return 1.0; return 2.0; }}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        linkCurvature={(link: object) => (link as any).curvature ?? 0}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        linkCurveRotation={(link: object) => (link as any).curvatureRotation ?? 0}
        linkOpacity={0.85}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.4}
        warmupTicks={60}
        onEngineStop={() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data=fg.current?.graphData(); const scene=fg.current?.scene() as THREE.Scene|undefined;
          let maxR=0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data?.nodes?.forEach((n:any)=>{ const r=Math.sqrt((n.x??0)**2+(n.y??0)**2+(n.z??0)**2); if(r>maxR) maxR=r; });
          if (scene && maxR > 10) {
            if (shellRef.current) { scene.remove(shellRef.current); shellRef.current.geometry.dispose(); }
            const shell = createBrainBoundaryShell(maxR*1.5);
            scene.add(shell); shellRef.current=shell;
            console.log(`[Brain] graphR=${maxR.toFixed(0)} shellR=${(maxR*1.5).toFixed(0)}`);
          }
          // Pin nodes so the layout stops drifting once settled
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data?.nodes?.forEach((n:any)=>{ n.fx=n.x; n.fy=n.y; n.fz=n.z; });
          // One-time framing only — no ambient camera motion afterwards
          fg.current?.zoomToFit(800,80);
        }}
        onNodeClick={onNodeClick}
        onBackgroundClick={onBgClick}
        showNavInfo={false}
      />
      {selNode && cam && cvs && (
        <NodeCard3D node={selNode} edges={edges} allNodes={nodes} camera={cam} domElement={cvs}
          onClose={onBgClick} onOpenNode={(id)=>{ const n=nodes.find(x=>x.id===id); if(n) onNodeClick(n); }} />
      )}
    </div>
  );
}
