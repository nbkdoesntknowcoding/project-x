import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ENTITY_LABELS, ENTITY_COLORS_CSS, EDGE_LABELS } from './constants';
import type { GraphNode, GraphEdge } from '../../lib/graph-types';

interface NodeCard3DProps {
  node: GraphNode | null;
  edges: GraphEdge[];
  allNodes: GraphNode[];
  camera: THREE.Camera;
  domElement: HTMLCanvasElement;
  onClose: () => void;
  onOpenNode: (nodeId: string) => void;
}

export function NodeCard3D({
  node, edges, allNodes, camera, domElement, onClose, onOpenNode,
}: NodeCard3DProps) {
  const [screenPos, setScreenPos] = useState<{ x: number; y: number } | null>(null);
  const animFrameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!node) { setScreenPos(null); return; }

    const updatePosition = () => {
      const nodePos = new THREE.Vector3(node.x ?? 0, node.y ?? 0, node.z ?? 0);
      nodePos.project(camera);

      const rect = domElement.getBoundingClientRect();
      const x = (nodePos.x * 0.5 + 0.5) * rect.width + rect.left;
      const y = (-nodePos.y * 0.5 + 0.5) * rect.height + rect.top;

      setScreenPos({ x: x + 40, y: y - 80 });
      animFrameRef.current = requestAnimationFrame(updatePosition);
    };

    animFrameRef.current = requestAnimationFrame(updatePosition);
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  }, [node, camera, domElement]);

  if (!node || !screenPos) return null;

  const connectedEdges = edges.filter(e =>
    e.fromNodeId === node.id || e.toNodeId === node.id
  ).slice(0, 5);

  const color = ENTITY_COLORS_CSS[node.entityType] ?? '#888888';
  const typeLabel = ENTITY_LABELS[node.entityType] ?? node.entityType;

  return (
    <div
      style={{
        position: 'fixed',
        left: Math.min(screenPos.x, window.innerWidth - 340),
        top: Math.max(screenPos.y, 20),
        width: 320,
        zIndex: 1000,
        pointerEvents: 'all',
        background: 'rgba(10,10,10,0.92)',
        backdropFilter: 'blur(20px)',
        border: `0.5px solid ${color}40`,
        borderRadius: 16,
        padding: '20px',
        fontFamily: "'Geist', -apple-system, sans-serif",
        animation: 'cardIn 200ms ease',
      }}
    >
      <style>{`
        @keyframes cardIn {
          from { opacity: 0; transform: translateY(8px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>

      <button
        onClick={onClose}
        style={{
          position: 'absolute', top: 12, right: 12,
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#52525b', fontSize: 16, lineHeight: 1,
        }}
      >×</button>

      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: `${color}18`,
        border: `0.5px solid ${color}40`,
        borderRadius: 6, padding: '4px 10px',
        fontSize: 11, fontFamily: "'Geist Mono', monospace",
        color, marginBottom: 10,
        textTransform: 'uppercase', letterSpacing: '0.04em',
      }}>
        {typeLabel}
      </div>

      <h3 style={{
        fontSize: 16, fontWeight: 500, color: '#fafafa',
        margin: '0 0 6px 0', lineHeight: 1.3,
      }}>
        {node.label}
      </h3>

      {node.summary && (
        <p style={{
          fontSize: 13, color: '#a1a1aa', lineHeight: 1.55,
          margin: '0 0 14px 0',
        }}>
          {node.summary}
        </p>
      )}

      {node.isGodNode && (
        <div style={{
          fontSize: 11, color: '#fbbf24',
          background: 'rgba(251,191,36,0.08)',
          border: '0.5px solid rgba(251,191,36,0.2)',
          borderRadius: 6, padding: '5px 10px',
          marginBottom: 14,
        }}>
          ⚡ One of the most connected nodes in your knowledge base
        </div>
      )}

      <div style={{ height: '0.5px', background: 'rgba(255,255,255,0.06)', marginBottom: 12 }} />

      {connectedEdges.length > 0 && (
        <>
          <p style={{
            fontSize: 11, fontFamily: "'Geist Mono', monospace",
            color: '#52525b', textTransform: 'uppercase',
            letterSpacing: '0.04em', margin: '0 0 8px 0',
          }}>
            Connected to
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {connectedEdges.map(edge => {
              const isOutgoing = edge.fromNodeId === node.id;
              const otherNodeId = isOutgoing ? edge.toNodeId : edge.fromNodeId;
              const otherNode = allNodes.find(n => n.id === otherNodeId);
              if (!otherNode) return null;

              const otherColor = ENTITY_COLORS_CSS[otherNode.entityType] ?? '#888888';
              const relationLabel = EDGE_LABELS[edge.edgeType ?? ''] ?? (edge.edgeType ?? 'connects');

              return (
                <div
                  key={edge.id ?? `${edge.fromNodeId}-${edge.toNodeId}`}
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '0.5px solid rgba(255,255,255,0.06)',
                    borderRadius: 8, padding: '8px 10px',
                    cursor: 'pointer',
                  }}
                  onClick={() => onOpenNode(otherNodeId)}
                >
                  <div style={{
                    fontSize: 10, color: '#52525b',
                    fontFamily: "'Geist Mono', monospace",
                    textTransform: 'lowercase', marginBottom: 3,
                  }}>
                    {isOutgoing ? '→' : '←'} {relationLabel}
                  </div>
                  <div style={{
                    fontSize: 13, color: '#fafafa', fontWeight: 400,
                    marginBottom: edge.rationale ? 4 : 0,
                  }}>
                    <span style={{
                      display: 'inline-block', width: 7, height: 7,
                      borderRadius: '50%', background: otherColor,
                      marginRight: 6, verticalAlign: 'middle',
                    }} />
                    {otherNode.label}
                  </div>
                  {edge.rationale && (
                    <div style={{
                      fontSize: 12, color: '#a1a1aa',
                      fontStyle: 'italic', lineHeight: 1.4,
                    }}>
                      "{edge.rationale}"
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {(node.entityType === 'doc' || node.entityType === 'flow' || node.entityType === 'task') && node.entityId && (
        <a
          href={`/app/${node.entityType === 'doc' ? 'docs' : node.entityType === 'flow' ? 'flows' : 'kanban'}/${node.entityId}`}
          style={{
            display: 'block', width: '100%',
            background: 'rgba(255,255,255,0.06)',
            border: '0.5px solid rgba(255,255,255,0.12)',
            borderRadius: 8, padding: '10px',
            textAlign: 'center', textDecoration: 'none',
            color: '#fafafa', fontSize: 13, boxSizing: 'border-box',
          }}
        >
          Open {typeLabel.split(' ').pop()} →
        </a>
      )}
    </div>
  );
}
