'use client';
import { useRef, useCallback, useEffect, useState } from 'react';
import ForceGraph3DLib from 'react-force-graph-3d';
// react-force-graph-3d's exported prop types are stricter than the runtime API
// (e.g. onNodeDragStart). Cast to any so the documented props pass typecheck.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph3D = ForceGraph3DLib as any;
import * as THREE from 'three';
import { createNodeObject, animateNode, clearNodeCache } from './node-objects';
import { setHighlight, clearHighlight } from './highlight';
import { setupBlackEnvironment, createStarField, createBrainBoundaryShell } from './environment';
import { NodeCard3D } from './NodeCard3D';
import type { GraphNode, GraphEdge } from '../../lib/graph-types';

interface Props { nodes: GraphNode[]; edges: GraphEdge[]; }

export function Graph3D({ nodes, edges }: Props) {
  const fg       = useRef<any>(null);
  const groups   = useRef(new Map<string, THREE.Group>());
  const shellRef = useRef<THREE.Points | null>(null);
  const done     = useRef(false);
  const rotating = useRef(false);
  const lastT    = useRef(performance.now());
  const iTimer   = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  useEffect(() => {
    if (!fg.current) return;
    fg.current.d3Force('charge')?.strength(-25);
    fg.current.d3Force('link')?.distance(() => 20);
    fg.current.d3Force('z-layer', (alpha: number) => {
      nodes.forEach((n: any) => {
        const tz = ((n.communityId ?? 0) % 5) * 25 - 50;
        n.vz = (n.vz ?? 0) + (tz - (n.z ?? 0)) * 0.005 * alpha;
      });
    });
    fg.current.d3Force('confine', (alpha: number) => {
      nodes.forEach((n: any) => {
        const nx = (n.x??0)/(0.83*180), ny = (n.y??0)/(0.69*180), nz = (n.z??0)/(1.00*180);
        const d = Math.sqrt(nx*nx+ny*ny+nz*nz);
        if (d > 0.9) {
          const f = 0.12*alpha*(d-0.9);
          n.vx=(n.vx??0)-(n.x??0)*f; n.vy=(n.vy??0)-(n.y??0)*f; n.vz=(n.vz??0)-(n.z??0)*f;
        }
      });
    });
  }, [nodes]);

  useEffect(() => {
    let raf: number;
    const tick = () => {
      try {
        const now = performance.now();
        const dt  = Math.min((now - lastT.current) / 1000, 0.05);
        lastT.current = now;
        if (rotating.current && fg.current) {
          const c = fg.current.camera() as THREE.Camera;
          const p = c.position;
          const r = Math.sqrt(p.x**2 + p.z**2);
          if (r > 1) { const a = Math.atan2(p.z,p.x)+0.0005; p.x=r*Math.cos(a); p.z=r*Math.sin(a); c.lookAt(0,0,0); }
        }
        groups.current.forEach(g => animateNode(g, dt, now/1000));
      } catch (_) {}
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (selNode) { rotating.current = false; clearTimeout(iTimer.current); }
    else { iTimer.current = setTimeout(() => { if (done.current) rotating.current = true; }, 1500); }
  }, [selNode]);

  useEffect(() => {
    const h = (e: CustomEvent) => {
      setTimeout(() => {
        const g = groups.current.get(e.detail.nodeId);
        if (!g) return;
        g.scale.setScalar(0);
        const s0 = performance.now();
        const grow = () => {
          const p = Math.min((performance.now()-s0)/1200,1);
          g.scale.setScalar(Math.max(0, 1+1.7*Math.pow(p-1,3)+1.7*Math.pow(p-1,2)));
          if (p < 1) requestAnimationFrame(grow);
        };
        requestAnimationFrame(grow);
      }, 300);
    };
    window.addEventListener('mnema:graph_node_added', h as EventListener);
    return () => window.removeEventListener('mnema:graph_node_added', h as EventListener);
  }, []);

  const pause = useCallback(() => {
    rotating.current = false; clearTimeout(iTimer.current);
    iTimer.current = setTimeout(() => { if (done.current) rotating.current = true; }, 3000);
  }, []);

  const onNodeClick = useCallback((raw: any) => {
    rotating.current = false; clearTimeout(iTimer.current);
    const node = raw as GraphNode;
    setSelNode(node);
    const conn = edges.filter(e=>e.fromNodeId===node.id||e.toNodeId===node.id).map(e=>e.fromNodeId===node.id?e.toNodeId:e.fromNodeId);
    setHighlight(node.id, conn, groups.current);
    const h = Math.hypot(raw.x??0,raw.y??0,raw.z??0);
    if (h > 0) {
      const ratio = 1+160/h;
      fg.current?.cameraPosition({x:(raw.x??0)*ratio,y:(raw.y??0)*ratio,z:(raw.z??0)*ratio},{x:raw.x??0,y:raw.y??0,z:raw.z??0},900);
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
          nodes: nodes.map(n=>({...n,val:Math.max(n.degree??1,1)})),
          links: edges.map(e=>({...e,source:e.fromNodeId,target:e.toNodeId})),
        }}
        backgroundColor="#000000"
        nodeThreeObject={(n: object) => { const g=createNodeObject(n as GraphNode); groups.current.set((n as GraphNode).id,g); return g; }}
        nodeThreeObjectExtend={false}
        nodeLabel={(n: object) => (n as GraphNode).label}
        linkColor={(l: object) => { const e=l as GraphEdge; if(e.provenance==='AMBIGUOUS') return 'rgba(255,255,255,0.03)'; if(e.provenance==='INFERRED') return 'rgba(255,255,255,0.08)'; return `rgba(255,255,255,${Math.min(0.06+(e.weight??1)*0.07,0.25)})`; }}
        linkWidth={(l: object) => { const e=l as GraphEdge; if(e.provenance==='AMBIGUOUS') return 0.15; if(e.provenance==='INFERRED') return 0.4; return Math.min(0.6+(e.weight??1)*0.2,1.5); }}
        linkDirectionalParticles={(l: object) => (l as GraphEdge).provenance==='EXTRACTED'?1:0}
        linkDirectionalParticleSpeed={0.004}
        linkDirectionalParticleWidth={1.0}
        linkDirectionalParticleColor={() => 'rgba(255,255,255,0.5)'}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.4}
        warmupTicks={60}
        onEngineStop={() => {
          const data=fg.current?.graphData(); const scene=fg.current?.scene() as THREE.Scene|undefined;
          let maxR=0;
          data?.nodes?.forEach((n:any)=>{ const r=Math.sqrt((n.x??0)**2+(n.y??0)**2+(n.z??0)**2); if(r>maxR) maxR=r; });
          if (scene && maxR > 10) {
            if (shellRef.current) { scene.remove(shellRef.current); shellRef.current.geometry.dispose(); }
            const shell = createBrainBoundaryShell(maxR*1.5);
            scene.add(shell); shellRef.current=shell;
            console.log(`[Brain] graphR=${maxR.toFixed(0)} shellR=${(maxR*1.5).toFixed(0)}`);
          }
          data?.nodes?.forEach((n:any)=>{ n.fx=n.x; n.fy=n.y; n.fz=n.z; });
          fg.current?.zoomToFit(800,80);
          setTimeout(()=>{ done.current=true; rotating.current=true; },1500);
        }}
        onNodeClick={onNodeClick}
        onBackgroundClick={onBgClick}
        onNodeDragStart={pause}
        onZoom={pause}
        showNavInfo={false}
      />
      {selNode && cam && cvs && (
        <NodeCard3D node={selNode} edges={edges} allNodes={nodes} camera={cam} domElement={cvs}
          onClose={onBgClick} onOpenNode={(id)=>{ const n=nodes.find(x=>x.id===id); if(n) onNodeClick(n); }} />
      )}
    </div>
  );
}
