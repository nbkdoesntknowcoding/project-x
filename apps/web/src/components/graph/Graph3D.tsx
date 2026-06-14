import { useRef, useCallback, useEffect, useState, memo, useMemo } from 'react';
import ForceGraph3DLib from 'react-force-graph-3d';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph3D = ForceGraph3DLib as any;
import * as THREE from 'three';
import { createNodeObject, animateNodeObject, clearNodeCache } from './node-objects';
import { setHighlight, clearHighlight } from './highlight';
import { setupBlackEnvironment, createStarField, addBloomAtmosphere, createBrainBoundaryShell } from './environment';
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
  const simulationDone = useRef(false);
  const engineStopped = useRef(false);           // one-shot guard — prevents repeated onEngineStop work
  const brainShellRef = useRef<THREE.Points | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null);          // OrbitControls — used for autoRotate

  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  // Refs (not state) so setting them doesn't trigger a re-render that would change
  // the graphData reference and restart the force simulation via resetCountdown().
  const cameraRef = useRef<THREE.Camera | null>(null);
  const domRef = useRef<HTMLCanvasElement | null>(null);

  // Reset guards when the graph data changes (new build)
  useEffect(() => {
    clearNodeCache();
    groupMapRef.current.clear();
    engineStopped.current = false;
    simulationDone.current = false;
    if (controlsRef.current) controlsRef.current.autoRotate = false;
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

    // Hook into OrbitControls for interaction detection.
    // This is the only correct way to detect pan — onZoom doesn't fire on right-drag.
    const controls = fgRef.current.controls();
    controlsRef.current = controls;
    if (controls) {
      controls.addEventListener('start', () => {
        isUserInteracting.current = true;
        controls.autoRotate = false;
        clearTimeout(interactionTimer.current);
      });
      controls.addEventListener('end', () => {
        clearTimeout(interactionTimer.current);
        interactionTimer.current = setTimeout(() => {
          isUserInteracting.current = false;
          if (simulationDone.current) controls.autoRotate = true;
        }, 3000);
      });
    }

    cameraRef.current = fgRef.current.camera();
    domRef.current = renderer.domElement as HTMLCanvasElement;
  }, []);

  // ── FORCE TUNING ──────────────────────────────────────────────────
  useEffect(() => {
    if (!fgRef.current) return;
    fgRef.current.d3Force('charge')?.strength(-30);
    fgRef.current.d3Force('link')?.distance(() => 25);
    fgRef.current.d3Force('z', (alpha: number) => {
      nodes.forEach((node: GraphNode & { vz?: number; z?: number }) => {
        const targetZ = ((node.communityId ?? 0) % 5) * 30 - 60;
        node.vz = (node.vz ?? 0) + (targetZ - (node.z ?? 0)) * 0.006 * alpha;
      });
    });
  }, [nodes]);


  // ── NODE ANIMATIONS (runs inside library render loop via postMessage trick) ──
  // We use a single shared RAF that piggybacks on the library's vsync by checking
  // if the library is idle. This avoids a second independent RAF loop.
  useEffect(() => {
    let animFrame: number;
    const animate = () => {
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

  // pauseRotation: also kills autoRotate so the camera stays put while user interacts
  const pauseRotation = useCallback(() => {
    isUserInteracting.current = true;
    if (controlsRef.current) controlsRef.current.autoRotate = false;
    clearTimeout(interactionTimer.current);
    interactionTimer.current = setTimeout(() => {
      isUserInteracting.current = false;
      if (simulationDone.current && controlsRef.current) {
        controlsRef.current.autoRotate = true;
      }
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

  // useMemo: graphData must only change reference when nodes/edges props change.
  // A new object every render causes the library's hasAnyPropChanged() to call
  // resetCountdown() → simulation restarts → warmupTicks runs synchronously → freeze.
  const graphData = useMemo(() => ({
    nodes: nodes.map(n => ({ ...n, val: n.degree ?? 1 })),
    links: edges.map(e => ({ ...e, source: e.fromNodeId, target: e.toNodeId })),
  }), [nodes, edges]);

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

        d3AlphaDecay={0.02}
        d3VelocityDecay={0.4}
        warmupTicks={30}
        cooldownTicks={100}
        onEngineStop={() => {
          // Guard: only run once per graph load. onEngineStop can fire multiple times.
          if (engineStopped.current) return;
          engineStopped.current = true;

          const data = fgRef.current?.graphData();
          const scene = fgRef.current?.scene();

          // A. Calculate actual graph radius from settled node positions
          let maxR = 0;
          if (data?.nodes) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data.nodes.forEach((node: any) => {
              const r = Math.sqrt((node.x ?? 0) ** 2 + (node.y ?? 0) ** 2 + (node.z ?? 0) ** 2);
              if (r > maxR) maxR = r;
            });
          }

          // B. Create brain shell sized to actual graph extent
          if (scene && maxR > 0) {
            if (brainShellRef.current) {
              scene.remove(brainShellRef.current);
              // Defer dispose so it doesn't stall the GPU mid-render
              const old = brainShellRef.current;
              setTimeout(() => old.geometry.dispose(), 0);
            }
            const shell = createBrainBoundaryShell(maxR * 1.5);
            scene.add(shell);
            brainShellRef.current = shell;
            console.log(`Brain shell: r=${(maxR * 1.5).toFixed(0)} (graph r=${maxR.toFixed(0)})`);
          }

          // C. Pin all nodes so simulation doesn't drift
          if (data?.nodes) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data.nodes.forEach((node: any) => {
              node.fx = node.x;
              node.fy = node.y;
              node.fz = node.z;
            });
          }

          // D. Fit the view
          fgRef.current?.zoomToFit?.(1000, 80);

          // E. Start autoRotate via OrbitControls 1.5s after fit animation
          setTimeout(() => {
            simulationDone.current = true;
            if (controlsRef.current && !isUserInteracting.current) {
              controlsRef.current.autoRotate = true;
              controlsRef.current.autoRotateSpeed = 0.3; // ~2°/s — slow, calm rotation
            }
          }, 1500);

          // F. Keep the library's render loop alive permanently — without this,
          //    the library enters idle mode after cooldown ticks and stops calling RAF,
          //    which means controls.update() stops being called and the scene freezes.
          fgRef.current?.resumeAnimation?.();
        }}

        onNodeClick={handleNodeClick}
        onBackgroundClick={handleBackgroundClick}
        onNodeDragStart={pauseRotation}
      />

      {selectedNode && cameraRef.current && domRef.current && (
        <NodeCard3D
          node={selectedNode}
          edges={edges}
          allNodes={nodes}
          camera={cameraRef.current}
          domElement={domRef.current}
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
