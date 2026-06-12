import { useRef, useCallback, useEffect, memo } from 'react';
import ForceGraph3DLib from 'react-force-graph-3d';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ForceGraph3D = ForceGraph3DLib as any;
import * as THREE from 'three';
import { NODE_COLORS_HEX, GOD_NODE_COLOR_HEX } from './graph-colors';
import type { GraphNode, GraphEdge } from '../../lib/graph-types';

interface Graph3DProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  highlightedNodeIds?: string[];
  onNodeClick: (node: GraphNode) => void;
  onBackgroundClick: () => void;
  width?: number;
  height?: number;
}

export const Graph3D = memo(function Graph3D({
  nodes,
  edges,
  highlightedNodeIds = [],
  onNodeClick,
  onBackgroundClick,
  width,
  height,
}: Graph3DProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const rotationRef   = useRef(true);
  const idleTimerRef  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bloomAddedRef = useRef(false);

  // ── BLOOM POST-PROCESSING ──────────────────────────────────────
  useEffect(() => {
    if (!fgRef.current || bloomAddedRef.current) return;
    // Dynamic import to avoid SSR issues with three/examples
    import('three/examples/jsm/postprocessing/UnrealBloomPass.js')
      .then(({ UnrealBloomPass }) => {
        if (!fgRef.current || bloomAddedRef.current) return;
        try {
          const bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            1.2,   // strength
            0.4,   // radius
            0.1,   // threshold
          );
          fgRef.current.postProcessingComposer()?.addPass(bloomPass);
          bloomAddedRef.current = true;
        } catch { /* bloom not available */ }
      })
      .catch(() => { /* three/examples not available */ });
  }, []);

  // ── AMBIENT ROTATION ───────────────────────────────────────────
  useEffect(() => {
    let animFrame: number;
    const rotate = () => {
      if (rotationRef.current && fgRef.current) {
        const camera = fgRef.current.camera?.();
        if (camera) {
          const r = Math.sqrt(camera.position.x ** 2 + camera.position.z ** 2);
          const theta = Math.atan2(camera.position.z, camera.position.x) + 0.0008;
          camera.position.x = r * Math.cos(theta);
          camera.position.z = r * Math.sin(theta);
          camera.lookAt(0, 0, 0);
        }
      }
      animFrame = requestAnimationFrame(rotate);
    };
    animFrame = requestAnimationFrame(rotate);
    return () => cancelAnimationFrame(animFrame);
  }, []);

  // ── PAUSE ROTATION ON INTERACTION ─────────────────────────────
  const pauseRotation = useCallback(() => {
    rotationRef.current = false;
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => { rotationRef.current = true; }, 3000);
  }, []);

  // ── NODE THREE.JS OBJECT ──────────────────────────────────────
  const nodeThreeObject = useCallback((node: object) => {
    const n = node as GraphNode;
    const isGodNode     = !!n.isGodNode;
    const isHighlighted = highlightedNodeIds.includes(n.id);
    const degree        = n.degree ?? 0;
    const radius        = Math.min(2 + degree * 0.25, 6) + (isGodNode ? 4 : 0);
    const color         = isGodNode
      ? GOD_NODE_COLOR_HEX
      : (NODE_COLORS_HEX[n.entityType] ?? 0x888888);

    const geometry = new THREE.SphereGeometry(radius, 14, 14);
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive:          color,
      emissiveIntensity: isGodNode ? 3.0 : isHighlighted ? 2.5 : 1.2,
      roughness: 0.2,
      metalness: 0.1,
    });
    const sphere = new THREE.Mesh(geometry, material);

    // God-node halo
    if (isGodNode) {
      const haloGeo = new THREE.SphereGeometry(radius * 2.5, 8, 8);
      const haloMat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.08,
        roughness: 1,
      });
      sphere.add(new THREE.Mesh(haloGeo, haloMat));
      // Mark for pulse animation
      (sphere as THREE.Mesh & { __isGodNode?: boolean; __createdAt?: number }).__isGodNode = true;
      (sphere as THREE.Mesh & { __createdAt?: number }).__createdAt = Date.now();
    }

    return sphere;
  }, [highlightedNodeIds]);

  // ── GOD-NODE PULSE ANIMATION ──────────────────────────────────
  useEffect(() => {
    if (!fgRef.current) return;
    const renderer = fgRef.current.renderer?.();
    if (!renderer) return;

    renderer.setAnimationLoop(() => {
      const now = Date.now();
      fgRef.current?.scene?.()?.traverse((obj: THREE.Object3D) => {
        const o = obj as THREE.Object3D & { __isGodNode?: boolean; __createdAt?: number };
        if (o.__isGodNode && o.__createdAt) {
          const t = (now - o.__createdAt) / 1000;
          const scale = 1 + Math.sin(t * 0.8) * 0.12;
          obj.scale.setScalar(scale);
        }
      });
    });
  }, []);

  // ── FORCE SIMULATION TUNING ───────────────────────────────────
  useEffect(() => {
    if (!fgRef.current) return;
    const fg = fgRef.current;
    fg.d3Force?.('charge')?.strength(-120);
    fg.d3Force?.('link')?.distance((link: GraphEdge) => {
      return 80 / (link.weight ?? 1);
    });
    // Z-spread: push communities to different Z-planes
    fg.d3Force?.('z', (_alpha: number) => {
      fg.graphData?.()?.nodes?.forEach((node: GraphNode & { vz?: number; z?: number }) => {
        const targetZ = (node.communityId ?? 0) * 40 - 100;
        node.vz = (node.vz ?? 0) + (targetZ - (node.z ?? 0)) * 0.01 * _alpha;
      });
    });
  }, []);

  // ── TRAVERSAL PATH PARTICLES ──────────────────────────────────
  const highlightedSet = new Set(highlightedNodeIds);

  const linkDirectionalParticles = useCallback((link: object) => {
    const l = link as GraphEdge & { __pathHighlight?: boolean };
    if (l.__pathHighlight) return 8;
    if ((l.provenance ?? 'EXTRACTED') === 'EXTRACTED') return 1;
    return 0;
  }, []);

  const linkDirectionalParticleColor = useCallback((link: object) => {
    const l = link as GraphEdge & { __pathHighlight?: boolean };
    return l.__pathHighlight ? '#fbbf24' : '#ffffff';
  }, []);

  const linkDirectionalParticleWidth = useCallback((link: object) => {
    const l = link as GraphEdge & { __pathHighlight?: boolean };
    return l.__pathHighlight ? 3 : 1.2;
  }, []);

  const linkColor = useCallback((link: object) => {
    const l = link as GraphEdge;
    if (l.provenance === 'INFERRED')  return '#1a1a2e';
    if (l.provenance === 'AMBIGUOUS') return '#151515';
    const alpha = Math.min(0.08 + (l.weight ?? 1) * 0.08, 0.35);
    return `rgba(255,255,255,${alpha})`;
  }, []);

  const linkWidth = useCallback((link: object) => {
    const l = link as GraphEdge;
    if (l.provenance === 'AMBIGUOUS') return 0.3;
    if (l.provenance === 'INFERRED')  return 0.5;
    return Math.min(0.8 + (l.weight ?? 1) * 0.3, 2.0);
  }, []);

  // ── GRAPH DATA ────────────────────────────────────────────────
  const graphData = {
    nodes: nodes.map(n => ({ ...n, val: n.degree ?? 1 })),
    links: edges.map(e => ({
      ...e,
      source: e.fromNodeId,
      target: e.toNodeId,
      __pathHighlight:
        highlightedSet.has(e.fromNodeId) && highlightedSet.has(e.toNodeId),
    })),
  };

  return (
    <ForceGraph3D
      ref={fgRef}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      graphData={graphData as any}
      backgroundColor="#050508"
      showNavInfo={false}

      nodeThreeObject={nodeThreeObject}
      nodeThreeObjectExtend={false}
      nodeLabel={(n: object) => (n as GraphNode).label ?? ''}
      nodeOpacity={1}

      linkColor={linkColor}
      linkWidth={linkWidth}
      linkOpacity={1}
      linkDirectionalArrowLength={0}
      linkDirectionalParticles={linkDirectionalParticles}
      linkDirectionalParticleSpeed={0.003}
      linkDirectionalParticleWidth={linkDirectionalParticleWidth}
      linkDirectionalParticleColor={linkDirectionalParticleColor}

      d3AlphaDecay={0.01}
      d3VelocityDecay={0.3}
      warmupTicks={50}
      cooldownTicks={200}

      onEngineStop={() => {
        fgRef.current?.zoomToFit?.(800, 80);
      }}

      onNodeClick={(node: object) => {
        pauseRotation();
        onNodeClick(node as GraphNode);
      }}
      onBackgroundClick={onBackgroundClick}
      onNodeDrag={pauseRotation}
      onZoom={pauseRotation}

      {...(width  !== undefined ? { width }  : {})}
      {...(height !== undefined ? { height } : {})}
    />
  );
});
