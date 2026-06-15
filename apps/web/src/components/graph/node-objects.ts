// apps/web/src/components/graph/node-objects.ts
import { ENTITY_COLORS_CSS } from './constants';
import type { GraphNode } from '../../lib/graph-types';

// Convert CSS hex color (#rrggbb) to rgba string
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Node radius — same scale as before: 2–10 units
export function getRadius(node: GraphNode): number {
  const base: Record<string, number> = {
    doc: 4, concept: 3, decision: 5, flow: 4,
    flow_step: 2, task: 3, project: 6, rationale: 2, session: 2,
  };
  return (base[node.entityType] ?? 3)
    + Math.min((node.degree ?? 0) * 0.25, 5)
    + ((node.isGodNode ?? false) ? 6 : 0);
}

// Draw a single node on the 2D canvas.
// Called by ForceGraph2D's nodeCanvasObject prop every frame.
export function drawNode(
  node: GraphNode,
  ctx: CanvasRenderingContext2D,
  selected: boolean,
  connected: boolean,
  anySelected: boolean,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const x      = (node as any).x ?? 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const y      = (node as any).y ?? 0;
  // Guard: createRadialGradient throws on non-finite coords. Never let one bad
  // node position blank the whole canvas.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const color  = ENTITY_COLORS_CSS[node.entityType] ?? '#ffffff';
  const radius = getRadius(node);
  const isGod  = node.isGodNode ?? false;

  // Opacity dimming when something else is selected
  let alpha = 1.0;
  if (anySelected && !selected && !connected) alpha = 0.06;

  // ── Glow halo ────────────────────────────────────────────────────
  // Soft radial gradient behind the node — the "glow" from the reference image
  const glowR = radius * (isGod ? 4.5 : 3.0);
  const grd   = ctx.createRadialGradient(x, y, 0, x, y, glowR);
  grd.addColorStop(0,   hexToRgba(color, 0.55 * alpha));
  grd.addColorStop(0.3, hexToRgba(color, 0.18 * alpha));
  grd.addColorStop(1,   hexToRgba(color, 0));
  ctx.beginPath();
  ctx.arc(x, y, glowR, 0, 2 * Math.PI);
  ctx.fillStyle = grd;
  ctx.fill();

  // ── Node dot ──────────────────────────────────────────────────────
  // The small solid circle — same as the reference dots
  const dotAlpha = selected ? 1.0 : alpha;
  const dotR     = selected ? radius * 1.3 : radius;
  ctx.beginPath();
  ctx.arc(x, y, dotR, 0, 2 * Math.PI);
  ctx.fillStyle = hexToRgba(color, dotAlpha);
  ctx.fill();

  // God-node: bright white inner core
  if (isGod && dotAlpha > 0.1) {
    ctx.beginPath();
    ctx.arc(x, y, dotR * 0.4, 0, 2 * Math.PI);
    ctx.fillStyle = `rgba(255,255,255,${0.7 * dotAlpha})`;
    ctx.fill();
  }
}

// Pointer area — how far from node centre counts as a click.
// The default (node radius) is too small for tiny nodes.
export function getPointerArea(node: GraphNode): number {
  return Math.max(getRadius(node) * 2.5, 8);
}
