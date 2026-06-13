import { useRef, useCallback, useEffect, useState, memo } from 'react';
import ForceGraph3DLib from 'react-force-graph-3d';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph3D = ForceGraph3DLib as any;
import * as THREE from 'three';
import { createNodeObject, animateNodeObject, clearNodeCache } from './node-objects';
import { setHighlight, clearHighlight } from './highlight';
import { setupBlackEnvironment, createStarField, addBloomAtmosphere } from './environment';
import { triggerNodeMaterialize, processAnimations } from './animations';
import { NodeCard3D } from './NodeCard3D';
import type { GraphNode, GraphEdge } from '../../lib/graph-types';

interface Graph3DProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const Graph3D = memo(function Graph3D({ nodes, edges }: Graph3DProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const groupMapRef = useRef<Map<string, THREE.Group>>(new Map());
  const clockRef = useRef(new THREE.Clock());
  const isUserInteracting = useRef(false);
  const interactionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const envInitRef = useRef(false);

  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [cameraRef, setCameraRef] = useState<THREE.Camera | null>(null);
  const [domRef, setDomRef] = useState<HTMLCanvasElement | null>(null);

  // Clear node cache when node list changes
  useEffect(() => {
    clearNodeCache();
    groupMapRef.current.clear();
  }, [nodes.length]);

  // ── ENVIRONMENT SETUP ─────────────────────────────────────────────
  useEffect(() => {
    if (!fgRef.current || envInitRef.current) return;
    envInitRef.current = true;

    const renderer = fgRef.current.renderer();
    const scene = fgRef.current.scene();

    setupBlackEnvironment(renderer, scene);

    const stars = createStarField();
    scene.add(stars);

    try {
      addBloomAtmosphere(fgRef.current.postProcessingComposer());
    } catch (e) {
      console.warn('Bloom atmosphere unavailable:', e);
    }

    setCameraRef(fgRef.current.camera());
    setDomRef(renderer.domElement as HTMLCanvasElement);
  }, []);

  // ── FORCE TUNING ──────────────────────────────────────────────────
  useEffect(() => {
    if (!fgRef.current) return;
    fgRef.current.d3Force('charge')?.strength(-200);
    fgRef.current.d3Force('link')?.distance((link: GraphEdge) =>
      60 + (1 / (link.weight ?? 1)) * 80,
    );
    fgRef.current.d3Force('z', (alpha: number) => {
      nodes.forEach((node: GraphNode & { vz?: number; z?: number }) => {
        const targetZ = ((node.communityId ?? 0) % 7) * 80 - 280;
        node.vz = (node.vz ?? 0) + (targetZ - (node.z ?? 0)) * 0.008 * alpha;
      });
    });
  }, [nodes]);

  // ── AMBIENT ROTATION ──────────────────────────────────────────────
  useEffect(() => {
    let animFrame: number;
    const animate = () => {
      if (!isUserInteracting.current && fgRef.current) {
        const cam = fgRef.current.camera() as THREE.PerspectiveCamera;
        const r = Math.sqrt(cam.position.x ** 2 + cam.position.z ** 2);
        const theta = Math.atan2(cam.position.z, cam.position.x) + 0.0008;
        cam.position.x = r * Math.cos(theta);
        cam.position.z = r * Math.sin(theta);
        cam.lookAt(0, 0, 0);
      }

      const delta = clockRef.current.getDelta();
      const now = performance.now();
      groupMapRef.current.forEach(group => animateNodeObject(group, delta, now / 1000));
      processAnimations(now, groupMapRef.current);

      animFrame = requestAnimationFrame(animate);
    };
    animFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrame);
  }, []);

  // ── SSE: NEW NODE MATERIALISES ────────────────────────────────────
  useEffect(() => {
    const handleSSE = (event: Event) => {
      const { nodeId, connectedNodeIds } = (event as CustomEvent).detail as {
        nodeId: string;
        connectedNodeIds: string[];
      };
      setTimeout(() => {
        const group = groupMapRef.current.get(nodeId);
        if (!group) return;
        const connectedGroups = connectedNodeIds
          .map(id => groupMapRef.current.get(id))
          .filter((g): g is THREE.Group => !!g);
        triggerNodeMaterialize(nodeId, group, connectedGroups);
      }, 300);
    };

    window.addEventListener('mnema:graph_node_added', handleSSE);
    return () => window.removeEventListener('mnema:graph_node_added', handleSSE);
  }, []);

  // ── FOCUS NODE (from search) ──────────────────────────────────────
  useEffect(() => {
    const handleFocus = (event: Event) => {
      const { nodeId } = (event as CustomEvent).detail as { nodeId: string };
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      handleNodeClick(node);
    };

    window.addEventListener('mnema:focus_node', handleFocus);
    return () => window.removeEventListener('mnema:focus_node', handleFocus);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  const pauseRotation = useCallback(() => {
    isUserInteracting.current = true;
    clearTimeout(interactionTimer.current);
    interactionTimer.current = setTimeout(() => {
      isUserInteracting.current = false;
    }, 3000);
  }, []);

  // ── NODE CLICK ────────────────────────────────────────────────────
  const handleNodeClick = useCallback((node: object) => {
    pauseRotation();
    const graphNode = node as GraphNode;
    setSelectedNode(graphNode);

    const connectedIds = edges
      .filter(e => e.fromNodeId === graphNode.id || e.toNodeId === graphNode.id)
      .map(e => e.fromNodeId === graphNode.id ? e.toNodeId : e.fromNodeId);

    setHighlight(graphNode.id, connectedIds, groupMapRef.current);

    if (!fgRef.current) return;
    const dist = 180;
    const nx = graphNode.x ?? 0;
    const ny = graphNode.y ?? 0;
    const nz = graphNode.z ?? 0;
    const magnitude = Math.hypot(nx, ny, nz) || 1;
    const ratio = 1 + dist / magnitude;
    fgRef.current.cameraPosition(
      { x: nx * ratio, y: ny * ratio, z: nz * ratio },
      { x: nx, y: ny, z: nz },
      1000,
    );
  }, [edges, pauseRotation]);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
    clearHighlight(groupMapRef.current);
    groupMapRef.current.forEach(group => group.scale.setScalar(1));
  }, []);

  const graphData = {
    nodes: nodes.map(n => ({ ...n, val: n.degree ?? 1 })),
    links: edges.map(e => ({ ...e, source: e.fromNodeId, target: e.toNodeId })),
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ForceGraph3D
        ref={fgRef}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        graphData={graphData as any}
        backgroundColor="#000000"
        showNavInfo={false}

        nodeThreeObject={(node: object) => {
          const n = node as GraphNode;
          const group = createNodeObject(n);
          groupMapRef.current.set(n.id, group);
          return group;
        }}
        nodeThreeObjectExtend={false}
        nodeLabel={(n: object) => (n as GraphNode).label ?? ''}

        linkColor={(link: object) => {
          const e = link as GraphEdge;
          if (e.provenance === 'AMBIGUOUS') return 'rgba(255,255,255,0.04)';
          if (e.provenance === 'INFERRED')  return 'rgba(255,255,255,0.09)';
          return `rgba(255,255,255,${Math.min(0.08 + (e.weight ?? 1) * 0.08, 0.28)})`;
        }}
        linkWidth={(link: object) => {
          const e = link as GraphEdge;
          if (e.provenance === 'AMBIGUOUS') return 0.2;
          if (e.provenance === 'INFERRED')  return 0.5;
          return Math.min(0.7 + (e.weight ?? 1) * 0.3, 2.0);
        }}
        linkOpacity={1}
        linkDirectionalArrowLength={0}
        linkDirectionalParticles={(link: object) => {
          const e = link as GraphEdge;
          return e.provenance === 'EXTRACTED' ? 1 : 0;
        }}
        linkDirectionalParticleSpeed={0.004}
        linkDirectionalParticleWidth={1.5}
        linkDirectionalParticleColor={() => 'rgba(255,255,255,0.6)'}

        d3AlphaDecay={0.01}
        d3VelocityDecay={0.3}
        warmupTicks={80}
        cooldownTicks={300}
        onEngineStop={() => fgRef.current?.zoomToFit?.(1200, 100)}

        onNodeClick={handleNodeClick}
        onBackgroundClick={handleBackgroundClick}
        onNodeDragStart={pauseRotation}
        onZoom={pauseRotation}
      />

      {selectedNode && cameraRef && domRef && (
        <NodeCard3D
          node={selectedNode}
          edges={edges}
          allNodes={nodes}
          camera={cameraRef}
          domElement={domRef}
          onClose={handleBackgroundClick}
          onOpenNode={(nodeId) => {
            const n = nodes.find(n => n.id === nodeId);
            if (n) handleNodeClick(n);
          }}
        />
      )}
    </div>
  );
});
