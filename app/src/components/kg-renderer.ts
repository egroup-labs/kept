/**
 * kg-renderer.ts — Pixi.js v8 wrapper for knowledge graph rendering.
 *
 * Provides GPU-accelerated node/edge drawing with zoom, pan, hit-testing,
 * and highlight/fade support.  Consumed by knowledge.ts which drives the
 * D3 force simulation and wires UI controls.
 */

import { Application, Container, Graphics, Text, TilingSprite, Texture } from 'pixi.js';
import type { BundleWorkerRequest, BundleWorkerResponse } from './bundle-worker';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface RendererNode {
  id: string;
  name: string;
  node_type: string;        // "entity" | "conversation" | "project"
  entity_type?: string;      // "technology", "person", "concept", etc.
  community?: number;        // Louvain community assignment
  frequency?: number;
  x: number;
  y: number;
}

export interface RendererEdge {
  sourceId: string;
  targetId: string;
  relation: string;
  weight: number;
}

export interface KgRendererOptions {
  container: HTMLElement;
  onNodeClick?: (nodeId: string) => void;
  onNodeHover?: (nodeId: string | null) => void;
  onBackgroundClick?: () => void;
  onBundleStateChange?: (bundling: boolean) => void;
  onCameraMove?: () => void;
}

// ── Theme constants ──────────────────────────────────────────────────────────

const THEME = {
  bg: 0x1c1b22,
  bgCenter: 0x27262e,
  text: 0xd4d0dc,
  textDim: 0x4a4852,
  edge: 0x8c82a0,
  edgeAlpha: 0.25,
  edgeHoverAlpha: 0.85,
  fadeAlpha: 0.12,
  dotGrid: 0x2a2930,
};

const ENTITY_TYPE_COLORS: Record<string, number> = {
  technology: 0x7aadd4,
  framework: 0x7ab5d8,
  library: 0x8ac2e0,
  language: 0x6aa0d8,
  tool: 0x72c8e8,
  person: 0x7ec48a,
  organization: 0x98cb9e,
  concept: 0xa994d2,
  method: 0xb878c4,
  algorithm: 0xcda8db,
  dataset: 0xe8b86a,
  metric: 0xe8a888,
  project: 0xd9a05b,
  decision: 0xd97070,
  conversation: 0x85739c,
  provider: 0xd97757,
  other: 0xa8b8c2,
};

// Community color palette — distinct saturated hues for Louvain clusters
const COMMUNITY_COLORS: number[] = [
  0xe06070, // rose
  0x5aafea, // sky blue
  0x68c87a, // green
  0xe8a850, // amber
  0xb478d0, // violet
  0x50c8c0, // teal
  0xe87890, // pink
  0x88a8e0, // periwinkle
  0xc8b040, // olive gold
  0xd08868, // terracotta
  0x70d0a0, // mint
  0xc090c0, // mauve
  0xa0c040, // lime
  0x6098b8, // steel blue
  0xe07050, // vermilion
  0x60d0d0, // cyan
];

function communityColor(community: number | undefined): number {
  if (community == null) return 0xa8b8c2;
  return COMMUNITY_COLORS[community % COMMUNITY_COLORS.length];
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Render labels at this multiple of the display size, then scale down.
 *  Keeps text crisp when the viewport is zoomed in.  */
const LABEL_OVERSAMPLE = 3;
const LABEL_FONT_SIZE = 11;

// ── Helpers ──────────────────────────────────────────────────────────────────

function nodeColor(node: RendererNode): number {
  if (node.node_type === 'provider') return ENTITY_TYPE_COLORS.provider;
  if (node.node_type === 'conversation') return ENTITY_TYPE_COLORS.conversation;
  if (node.node_type === 'project') return ENTITY_TYPE_COLORS.project;
  // Use community color if available (emergent Louvain clustering)
  if (node.community != null) return communityColor(node.community);
  if (node.entity_type && ENTITY_TYPE_COLORS[node.entity_type]) {
    return ENTITY_TYPE_COLORS[node.entity_type];
  }
  return ENTITY_TYPE_COLORS.concept;
}

function nodeRadius(node: RendererNode): number {
  if (node.node_type === 'provider') return 14;
  if (node.node_type === 'project') return 14;
  if (node.node_type === 'conversation') return 9;
  const freq = node.frequency ?? 1;
  return Math.min(12, Math.max(4.5, 3.5 + Math.sqrt(freq)));
}

// ── Internal bookkeeping per-node ────────────────────────────────────────────

interface NodeEntry {
  node: RendererNode;
  graphic: Graphics;
  label: Text;
  radius: number;
  color: number;
  tier: 1 | 2 | 3;
  hoverDotScale: number;
  hoverLabelScale: number;
}

// ── Convex hull (Graham scan) ────────────────────────────────────────────────

function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 3) return points.slice();

  // Find lowest-y (then leftmost) pivot
  let pivot = points[0];
  for (const p of points) {
    if (p.y < pivot.y || (p.y === pivot.y && p.x < pivot.x)) pivot = p;
  }

  const sorted = points
    .filter((p) => p !== pivot)
    .sort((a, b) => {
      const aa = Math.atan2(a.y - pivot.y, a.x - pivot.x);
      const ba = Math.atan2(b.y - pivot.y, b.x - pivot.x);
      return aa - ba || a.x - b.x;
    });

  const stack = [pivot, sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    while (stack.length > 1) {
      const top = stack[stack.length - 1];
      const below = stack[stack.length - 2];
      const cross =
        (top.x - below.x) * (sorted[i].y - below.y) -
        (top.y - below.y) * (sorted[i].x - below.x);
      if (cross <= 0) stack.pop();
      else break;
    }
    stack.push(sorted[i]);
  }
  return stack;
}

/** Expand hull outward by `pad` pixels and return rounded-corner path points. */
function expandHull(hull: { x: number; y: number }[], pad: number): { x: number; y: number }[] {
  if (hull.length < 2) return hull;

  // Compute centroid
  let cx = 0, cy = 0;
  for (const p of hull) { cx += p.x; cy += p.y; }
  cx /= hull.length;
  cy /= hull.length;

  // Push each point outward from centroid
  return hull.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: p.x + (dx / dist) * pad, y: p.y + (dy / dist) * pad };
  });
}

// ── KgRenderer class ─────────────────────────────────────────────────────────

export class KgRenderer {
  // Pixi core
  private app: Application;
  private viewport: Container;
  private hullLayer: Container;
  private edgeLayer: Container;
  private nodeLayer: Container;
  private labelLayer: Container;
  private edgeGraphics: Graphics;
  private hullGraphics: Graphics;

  // Dot grid (screen-space TilingSprite — one draw call)
  private dotTiling: TilingSprite | null = null;
  private static readonly DOT_SPACING = 30;

  // Data
  private nodeMap = new Map<string, NodeEntry>();
  private nodes: RendererNode[] = [];
  private edges: RendererEdge[] = [];

  // Camera state
  private camX = 0;
  private camY = 0;
  private camScale = 1;
  private cameraDirty = false;
  private cameraRafId = 0;

  // Interaction state
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private camStartX = 0;
  private camStartY = 0;
  private hoveredNodeId: string | null = null;
  private hoverConnectedSet: Set<string> | null = null;
  private hoverLabelSet: Set<string> | null = null;
  private hoverStartTime = 0;
  private hoverDimRafId = 0;
  private highlightedSet: Set<string> | null = null;
  private selectionLabelSet: Set<string> | null = null;
  private highlightedNodeId: string | null = null;
  private fadedSet: Set<string> | null = null;

  /** camScale thresholds for 2D tier visibility (inverse of 3D dZ).
   *  Dots always visible (no zoom gating) — only opacity varies by tier.
   *  Labels use zoom-gated progressive disclosure. */
  private static readonly TIER_2D = {
    1: { dot: { start: 0, end: 0, maxOp: 1.0 }, label: { start: 0, end: 0, maxOp: 1.0 } },
    2: { dot: { start: 0, end: 0, maxOp: 0.55 }, label: { start: 0.6, end: 0.85, maxOp: 0.8 } },
    3: { dot: { start: 0, end: 0, maxOp: 0.3 }, label: { start: 1.1, end: 2.0, maxOp: 0.6 } },
  } as const;

  private tierDotOp2D(tier: 1 | 2 | 3): number {
    const th = KgRenderer.TIER_2D[tier].dot;
    if (th.start === th.end) return th.maxOp; // always visible
    const t = Math.max(0, Math.min(1, (this.camScale - th.start) / (th.end - th.start)));
    return th.maxOp * t * t * (3 - 2 * t);
  }

  private tierLabelOp2D(tier: 1 | 2 | 3): number {
    const th = KgRenderer.TIER_2D[tier].label;
    if (th.start === th.end) return th.maxOp; // always visible
    const t = Math.max(0, Math.min(1, (this.camScale - th.start) / (th.end - th.start)));
    return th.maxOp * t * t * (3 - 2 * t);
  }

  // Glow graphics for highlighted node
  private glowGraphics: Graphics | null = null;

  // Options
  private containerEl: HTMLElement;
  private onNodeClick?: (nodeId: string) => void;
  private onNodeHover?: (nodeId: string | null) => void;
  private onBackgroundClick?: () => void;
  private onBundleStateChange?: (bundling: boolean) => void;
  private onCameraMove?: () => void;

  // Resize observer
  private resizeObserver: ResizeObserver | null = null;

  // Animation frame tracking
  private animRafId = 0;

  // Cleanup references
  private boundWheel: ((e: WheelEvent) => void) | null = null;
  private boundPointerDown: ((e: PointerEvent) => void) | null = null;
  private boundPointerMove: ((e: PointerEvent) => void) | null = null;
  private boundPointerUp: ((e: PointerEvent) => void) | null = null;

  constructor(opts: KgRendererOptions) {
    this.containerEl = opts.container;
    this.onNodeClick = opts.onNodeClick;
    this.onNodeHover = opts.onNodeHover;
    this.onBackgroundClick = opts.onBackgroundClick;
    this.onBundleStateChange = opts.onBundleStateChange;
    this.onCameraMove = opts.onCameraMove;

    this.app = new Application();

    // Create z-ordered layers inside a viewport container
    this.viewport = new Container();
    this.hullLayer = new Container();
    this.edgeLayer = new Container();
    this.nodeLayer = new Container();
    this.nodeLayer.sortableChildren = true;
    this.labelLayer = new Container();
    this.labelLayer.sortableChildren = true;
    this.edgeGraphics = new Graphics();
    this.hullGraphics = new Graphics();

    this.viewport.addChild(this.hullLayer);
    this.viewport.addChild(this.edgeLayer);
    this.viewport.addChild(this.nodeLayer);
    this.viewport.addChild(this.labelLayer);
    this.hullLayer.addChild(this.hullGraphics);
    this.edgeLayer.addChild(this.edgeGraphics);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const rect = this.containerEl.getBoundingClientRect();
    await this.app.init({
      width: rect.width || 800,
      height: rect.height || 600,
      backgroundColor: THEME.bg,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      autoStart: true,
    });

    // Append the canvas
    const canvas = this.app.canvas as HTMLCanvasElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    this.containerEl.appendChild(canvas);

    // Create dot-grid TilingSprite (screen-space, behind viewport)
    this.initDotTiling();

    // Add viewport to stage
    this.app.stage.addChild(this.viewport);

    // Setup interaction listeners
    this.setupInteraction();

    // Observe container resize
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.containerEl);
  }

  destroy(): void {
    // Remove interaction listeners
    const canvas = this.app.canvas as HTMLCanvasElement;
    if (this.boundWheel) {
      canvas.removeEventListener('wheel', this.boundWheel);
    }
    if (this.boundPointerDown) {
      canvas.removeEventListener('pointerdown', this.boundPointerDown);
    }
    if (this.boundPointerMove) {
      canvas.removeEventListener('pointermove', this.boundPointerMove);
    }
    if (this.boundPointerUp) {
      canvas.removeEventListener('pointerup', this.boundPointerUp);
    }

    // Disconnect resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Terminate bundle worker
    if (this.bundleWorker) {
      this.bundleWorker.terminate();
      this.bundleWorker = null;
    }

    // Cancel pending RAF + ticker
    if (this.cameraRafId) {
      cancelAnimationFrame(this.cameraRafId);
      this.cameraRafId = 0;
    }
    if (this.animRafId) {
      cancelAnimationFrame(this.animRafId);
      this.animRafId = 0;
    }
    if (this.hoverDimRafId) {
      cancelAnimationFrame(this.hoverDimRafId);
      this.hoverDimRafId = 0;
    }
    if (this.tickerBound) {
      this.app.ticker.remove(this.flushDirty, this);
      this.tickerBound = false;
    }

    // Clean up dot tiling
    if (this.dotTiling) {
      this.dotTiling.destroy();
      this.dotTiling = null;
    }

    // Destroy Pixi app (removes canvas)
    this.app.destroy(true, { children: true });
    this.nodeMap.clear();
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  setData(nodes: RendererNode[], edges: RendererEdge[]): void {
    // Clear existing
    this.clearAllGraphics();

    this.nodes = nodes;
    this.edges = edges;
    this.bundleDirty = true;

    // Create graphics for each node
    for (const node of nodes) {
      this.createNodeGraphic(node);
    }

    // Assign tiers based on intensity (frequency-derived)
    this.assignTiers();

    // Draw edges and hulls
    this.drawEdges();
    this.drawHulls();

    // Fit everything in view
    this.fitToView(false);
  }

  updatePositions(positions: Map<string, { x: number; y: number }>): void {
    for (const [id, pos] of positions) {
      const entry = this.nodeMap.get(id);
      if (!entry) continue;
      entry.node.x = pos.x;
      entry.node.y = pos.y;
      entry.graphic.position.set(pos.x, pos.y);
      entry.label.position.set(pos.x, pos.y + entry.radius + 10);
    }
    this.bundleDirty = true;
    this.edgeCacheKey = null; // positions changed — force edge rebuild
    // Defer edge/hull redraws to the next ticker frame
    this.edgesDirty = true;
    this.hullsDirty = true;
    this.ensureTickerFlush();
  }

  // ── Camera ───────────────────────────────────────────────────────────────

  fitToView(animate?: boolean): void {
    if (this.nodes.length === 0) return;

    const padding = 80;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of this.nodes) {
      const r = nodeRadius(node);
      if (node.x - r < minX) minX = node.x - r;
      if (node.y - r < minY) minY = node.y - r;
      if (node.x + r > maxX) maxX = node.x + r;
      if (node.y + r > maxY) maxY = node.y + r;
    }

    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;

    if (bboxW <= 0 || bboxH <= 0) {
      this.camX = this.nodes[0].x;
      this.camY = this.nodes[0].y;
      this.camScale = 1;
      this.applyCamera();
      this.cullNodes();
      return;
    }

    const scaleX = (w - padding * 2) / bboxW;
    const scaleY = (h - padding * 2) / bboxH;
    this.camScale = Math.min(scaleX, scaleY, 2);
    this.camScale = Math.max(0.1, Math.min(5, this.camScale));

    this.camX = (minX + maxX) / 2;
    this.camY = (minY + maxY) / 2;

    if (animate) {
      // Cancel any running animation before starting a new one
      if (this.animRafId) {
        cancelAnimationFrame(this.animRafId);
        this.animRafId = 0;
      }

      // Simple animation: apply over several frames
      const targetX = this.camX;
      const targetY = this.camY;
      const targetScale = this.camScale;
      const startX = this.viewport.x;
      const startY = this.viewport.y;
      const startScale = this.viewport.scale.x;

      const targetVpX = w / 2 - targetX * targetScale;
      const targetVpY = h / 2 - targetY * targetScale;

      let frame = 0;
      const totalFrames = 20;
      const step = () => {
        frame++;
        const t = frame / totalFrames;
        const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
        this.viewport.x = startX + (targetVpX - startX) * ease;
        this.viewport.y = startY + (targetVpY - startY) * ease;
        const s = startScale + (targetScale - startScale) * ease;
        this.viewport.scale.set(s, s);
        this.cullNodes();
        if (frame < totalFrames) {
          this.animRafId = requestAnimationFrame(step);
        } else {
          this.animRafId = 0;
        }
      };
      this.animRafId = requestAnimationFrame(step);
    } else {
      this.applyCamera();
      this.cullNodes();
    }
  }

  zoomToNode(nodeId: string): void {
    const entry = this.nodeMap.get(nodeId);
    if (!entry) return;

    // Cancel any running animation before starting a new one
    if (this.animRafId) {
      cancelAnimationFrame(this.animRafId);
      this.animRafId = 0;
    }

    const w = this.app.screen.width;
    const h = this.app.screen.height;

    const targetScale = 1.5;
    const targetX = entry.node.x;
    const targetY = entry.node.y;

    const startVpX = this.viewport.x;
    const startVpY = this.viewport.y;
    const startScale = this.viewport.scale.x;

    const targetVpX = w / 2 - targetX * targetScale;
    const targetVpY = h / 2 - targetY * targetScale;

    let frame = 0;
    const totalFrames = 50;
    const step = () => {
      frame++;
      const t = frame / totalFrames;
      // easeInOutCubic: slow start, accelerate, slow end
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const s = startScale + (targetScale - startScale) * ease;
      this.viewport.x = startVpX + (targetVpX - startVpX) * ease;
      this.viewport.y = startVpY + (targetVpY - startVpY) * ease;
      this.viewport.scale.set(s, s);
      this.camX = targetX;
      this.camY = targetY;
      this.camScale = s;
      this.updateDotTiling();
      this.cullNodes();
      this.onCameraMove?.();
      if (frame < totalFrames) {
        this.animRafId = requestAnimationFrame(step);
      } else {
        this.animRafId = 0;
      }
    };
    this.animRafId = requestAnimationFrame(step);
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    // Convert screen point to world before zoom
    const world = this.screenToWorld(sx, sy);

    this.camScale *= factor;
    this.camScale = Math.max(0.1, Math.min(5, this.camScale));

    // Adjust camera so the world point stays under the screen point
    this.camX = world.x - (sx - this.app.screen.width / 2) / this.camScale;
    this.camY = world.y - (sy - this.app.screen.height / 2) / this.camScale;

    this.scheduleCameraUpdate();
  }

  // ── Highlight / Fade ─────────────────────────────────────────────────────

  highlightNode(nodeId: string): void {
    // Remove any existing glow
    this.removeGlow();

    // Find connected node IDs via edges
    const connected = new Set<string>();
    connected.add(nodeId);
    for (const edge of this.edges) {
      if (edge.sourceId === nodeId) connected.add(edge.targetId);
      if (edge.targetId === nodeId) connected.add(edge.sourceId);
    }

    this.highlightedSet = connected;
    this.highlightedNodeId = nodeId;

    // Cap selection labels: selected node + closest N neighbors
    const MAX_SEL_LABELS = 10;
    const selEntry = this.nodeMap.get(nodeId);
    const sx = selEntry?.node.x ?? 0, sy = selEntry?.node.y ?? 0;
    const neighborIds = [...connected].filter(id => id !== nodeId);
    const selLabelCandidates = neighborIds
      .map(id => this.nodeMap.get(id))
      .filter((e): e is NodeEntry => e != null)
      .sort((a, b) => {
        const da = (a.node.x - sx) ** 2 + (a.node.y - sy) ** 2;
        const db = (b.node.x - sx) ** 2 + (b.node.y - sy) ** 2;
        return da - db;
      })
      .slice(0, MAX_SEL_LABELS);
    this.selectionLabelSet = new Set([nodeId, ...selLabelCandidates.map(e => e.node.id)]);

    // Fade non-connected nodes
    for (const [id, entry] of this.nodeMap) {
      if (connected.has(id)) {
        entry.graphic.alpha = 1;
        entry.label.alpha = 1;
      } else {
        entry.graphic.alpha = THEME.fadeAlpha;
        entry.label.alpha = THEME.fadeAlpha;
      }
    }

    // Draw glow ring behind selected node
    const entry = this.nodeMap.get(nodeId);
    if (entry) {
      const glow = new Graphics();
      // Outer glow
      glow.circle(0, 0, entry.radius + 14);
      glow.fill({ color: entry.color, alpha: 0.1 });
      // Inner glow
      glow.circle(0, 0, entry.radius + 8);
      glow.fill({ color: entry.color, alpha: 0.25 });

      glow.position.set(entry.node.x, entry.node.y);
      // Add behind the node graphic (at the bottom of nodeLayer)
      this.nodeLayer.addChildAt(glow, 0);
      this.glowGraphics = glow;
    }

    // Draw edges with highlight
    this.drawEdgesHighlighted(nodeId, connected);
  }

  clearHighlight(): void {
    this.highlightedSet = null;
    this.selectionLabelSet = null;
    this.highlightedNodeId = null;
    this.removeGlow();

    for (const [, entry] of this.nodeMap) {
      entry.graphic.alpha = 1;
      entry.label.alpha = 1;
    }

    // Reapply faded set if any
    if (this.fadedSet) {
      this.applyFadeSet();
    }

    this.drawEdges();
    this.cullNodes();
  }

  setFadedNodes(nodeIds: Set<string>): void {
    this.fadedSet = nodeIds;
    this.applyFadeSet();
  }

  /** Enable/disable edge bundling (disable during simulation for performance). */
  setBundling(enabled: boolean): void {
    this.bundlingEnabled = enabled;
    if (enabled) {
      this.bundleDirty = true;
      this.drawEdges();
    }
  }

  // ── Coordinate transforms ────────────────────────────────────────────────

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.camX) * this.camScale + this.app.screen.width / 2,
      y: (wy - this.camY) * this.camScale + this.app.screen.height / 2,
    };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.app.screen.width / 2) / this.camScale + this.camX,
      y: (sy - this.app.screen.height / 2) / this.camScale + this.camY,
    };
  }

  // ── Private: Node creation ───────────────────────────────────────────────

  private createNodeGraphic(node: RendererNode): void {
    const r = nodeRadius(node);
    const color = nodeColor(node);

    const g = new Graphics();

    if (node.node_type === 'provider') {
      // Tetrahedron projection — equilateral triangle
      const s = r * 1.15; // slightly larger to match visual weight of circles
      const ax = 0, ay = -s;
      const bx = -s * 0.866, by = s * 0.5;
      const cx = s * 0.866, cy = s * 0.5;

      // Glow
      const gs = s + 4;
      const gax = 0, gay = -gs;
      const gbx = -gs * 0.866, gby = gs * 0.5;
      const gcx = gs * 0.866, gcy = gs * 0.5;
      g.poly([gax, gay, gbx, gby, gcx, gcy]);
      g.fill({ color, alpha: 0.15 });

      // Main fill
      g.poly([ax, ay, bx, by, cx, cy]);
      g.fill({ color, alpha: 0.9 });

      // Border
      g.poly([ax, ay, bx, by, cx, cy]);
      g.stroke({ color: 0xffffff, alpha: 0.15, width: 1 });
    } else {
      // Sphere projection — circle
      // Glow ring (slightly larger, low alpha)
      g.circle(0, 0, r + 4);
      g.fill({ color, alpha: 0.15 });

      // Main circle
      g.circle(0, 0, r);
      g.fill({ color, alpha: 0.9 });

      // Border ring
      g.circle(0, 0, r);
      g.stroke({ color: 0xffffff, alpha: 0.15, width: 1 });
    }

    g.position.set(node.x, node.y);
    g.eventMode = 'static';
    g.cursor = 'pointer';

    this.nodeLayer.addChild(g);

    // Label — rendered at LABEL_OVERSAMPLE × size then scaled down so text
    // stays crisp when the user zooms into the graph.
    const label = new Text({
      text: node.name,
      style: {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: LABEL_FONT_SIZE * LABEL_OVERSAMPLE,
        fill: THEME.text,
        align: 'center',
      },
    });
    label.anchor.set(0.5, 0);
    label.scale.set(1 / LABEL_OVERSAMPLE);
    label.position.set(node.x, node.y + r + 10);
    this.labelLayer.addChild(label);

    const entry: NodeEntry = { node, graphic: g, label, radius: r, color, tier: 3, hoverDotScale: 1, hoverLabelScale: 1 };
    this.nodeMap.set(node.id, entry);
  }

  // ── Private: KDEEB Edge Bundling (Web Worker) ───────────────────────────

  /** Cached bundled control points per edge index — invalidated on position update. */
  private bundledPaths: { x: number; y: number }[][] = [];
  private bundleDirty = true;
  private bundlingEnabled = true;
  private bundleWorker: Worker | null = null;
  private bundleComputing = false;
  private bundleGeneration = 0;

  /** Cache key for edge Graphics — skip clear()+rebuild when nothing changed. */
  private edgeCacheKey: string | null = null;

  /** Dirty flags — deferred edge/hull redraws flushed once per frame via ticker. */
  private edgesDirty = false;
  private hullsDirty = false;
  private tickerBound = false;

  /**
   * Kick off KDEEB in a Web Worker. When the worker finishes,
   * it stores the result and triggers a redraw.
   */
  private computeBundleAsync(): void {
    if (!this.bundleDirty && this.bundledPaths.length === this.edges.length) return;
    this.bundleDirty = false;
    this.bundleComputing = true;
    this.onBundleStateChange?.(true);

    const generation = ++this.bundleGeneration;

    // Build node position map
    const nodePos: Record<string, { x: number; y: number }> = {};
    for (const [id, entry] of this.nodeMap) {
      nodePos[id] = { x: entry.node.x, y: entry.node.y };
    }

    // Build edge list
    const bundleEdges = this.edges.map(e => ({
      source: e.sourceId,
      target: e.targetId,
    }));

    // Create worker lazily
    if (!this.bundleWorker) {
      this.bundleWorker = new Worker(
        new URL('./bundle-worker.ts', import.meta.url),
        { type: 'module' },
      );
    }

    this.bundleWorker.onmessage = (evt: MessageEvent<BundleWorkerResponse>) => {
      // Ignore stale responses
      if (evt.data.generation !== this.bundleGeneration) return;

      this.bundledPaths = evt.data.paths;
      this.bundleComputing = false;
      this.onBundleStateChange?.(false);
      // Redraw edges now that bundled paths are ready
      if (this.highlightedSet && this.highlightedNodeId) {
        this.drawEdgesHighlighted(this.highlightedNodeId, this.highlightedSet);
      } else {
        this.drawEdges();
      }
    };

    this.bundleWorker.onerror = () => {
      this.bundleComputing = false;
      this.onBundleStateChange?.(false);
    };

    const msg: BundleWorkerRequest = {
      nodes: nodePos,
      edges: bundleEdges,
      opts: {
        samples: 64,
        iterations: 20,
        gradientTau: 0.03,
        pinZone: 0.22,
        directionalBins: 4,
        adaptiveAttraction: true,
        perpBias: 0.6,
        splatSkipZone: 0.22,
        postSmoothIters: 10,
        stepStartFactor: 0.012,
      },
      generation,
    };
    this.bundleWorker.postMessage(msg);
  }

  /** LOD stride for bundled edge polylines — skip points at low zoom. */
  private get lodStride(): number {
    if (this.camScale >= 0.8) return 1;
    if (this.camScale >= 0.4) return 2;
    return 4;
  }

  // ── Private: Edge drawing (batched by style, with LOD + viewport culling) ─

  /** AABB viewport check — returns true if an edge between two world-space
   *  points is potentially visible on screen (with 100px margin). */
  private edgeInView(x1: number, y1: number, x2: number, y2: number): boolean {
    const margin = 100;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const minSX = Math.min(
      (x1 - this.camX) * this.camScale + w / 2,
      (x2 - this.camX) * this.camScale + w / 2,
    );
    const maxSX = Math.max(
      (x1 - this.camX) * this.camScale + w / 2,
      (x2 - this.camX) * this.camScale + w / 2,
    );
    const minSY = Math.min(
      (y1 - this.camY) * this.camScale + h / 2,
      (y2 - this.camY) * this.camScale + h / 2,
    );
    const maxSY = Math.max(
      (y1 - this.camY) * this.camScale + h / 2,
      (y2 - this.camY) * this.camScale + h / 2,
    );
    return maxSX >= -margin && minSX <= w + margin && maxSY >= -margin && minSY <= h + margin;
  }

  /** Draw a bundled polyline into the current Graphics path.
   *  At high zoom (stride 1) uses quadratic smoothing so edges look clean.
   *  At lower zoom / higher stride, uses straight lineTo — segments are
   *  sub-pixel so smoothing is invisible, and skipping tessellation is a win. */
  private traceBundledEdge(g: Graphics, pts: { x: number; y: number }[], stride = 1): void {
    g.moveTo(pts[0].x, pts[0].y);
    if (stride > 1) {
      // Low zoom — straight segments (sub-pixel, no visible difference)
      for (let i = stride; i < pts.length - 1; i += stride) {
        g.lineTo(pts[i].x, pts[i].y);
      }
      g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    } else {
      // High zoom — quadratic smoothing for clean curves
      if (pts.length <= 2) {
        g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        return;
      }
      for (let s = 1; s < pts.length - 1; s++) {
        const curr = pts[s];
        const next = pts[s + 1];
        const mx = (curr.x + next.x) / 2;
        const my = (curr.y + next.y) / 2;
        g.quadraticCurveTo(curr.x, curr.y, mx, my);
      }
      g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    }
  }

  private drawEdges(): void {
    const hasBundledPaths = this.bundledPaths.length === this.edges.length;

    if (this.bundlingEnabled && !hasBundledPaths && !this.bundleComputing) {
      this.computeBundleAsync();
    }

    // Cache check — skip clear()+rebuild when nothing changed
    const hoverKey = this.hoveredNodeId ?? 'none';
    const cacheKey = `${this.bundleGeneration}_${hoverKey}_${this.lodStride}`;
    if (this.edgeCacheKey === cacheKey) return;

    const g = this.edgeGraphics;
    g.clear();

    if (this.bundlingEnabled && hasBundledPaths) {
      this.drawEdgesBundledBatched(g, null);
    } else {
      this.drawEdgesStraight(g, null);
    }

    this.edgeCacheKey = cacheKey;
  }

  private drawEdgesHighlighted(focusNodeId: string, connected: Set<string>): void {
    // Cache check — skip clear()+rebuild when nothing changed
    const cacheKey = `${this.bundleGeneration}_${focusNodeId}_${this.lodStride}`;
    if (this.edgeCacheKey === cacheKey) return;

    const g = this.edgeGraphics;
    g.clear();
    const hasBundledPaths = this.bundledPaths.length === this.edges.length;
    if (this.bundlingEnabled && hasBundledPaths) {
      this.drawEdgesBundledBatched(g, connected, focusNodeId);
    } else {
      this.drawEdgesStraight(g, connected, focusNodeId, true, true);
    }

    this.edgeCacheKey = cacheKey;
  }

  /** Bundled edge rendering — batched by style key, with viewport culling. */
  private drawEdgesBundledBatched(
    g: Graphics,
    connected: Set<string> | null,
    focusNodeId: string | null = null,
  ): void {
    // Collect edges into style-key buckets (numeric key = (color << 1) | category)
    const buckets = new Map<number, { color: number; alpha: number; width: number; indices: number[] }>();

    for (let i = 0; i < this.edges.length; i++) {
      const edge = this.edges[i];
      const pts = this.bundledPaths[i];
      if (!pts || pts.length < 2) continue;

      // Viewport cull using source/target positions
      const src = this.nodeMap.get(edge.sourceId);
      const tgt = this.nodeMap.get(edge.targetId);
      if (!src || !tgt) continue;
      if (!this.edgeInView(src.node.x, src.node.y, tgt.node.x, tgt.node.y)) continue;

      // Skip edges where either endpoint is not visible (tier-based)
      if (src.graphic.alpha < 0.1 || tgt.graphic.alpha < 0.1) continue;

      let color: number, alpha: number, width: number, category: number;
      if (connected || this.hoverConnectedSet) {
        const focusId = focusNodeId || this.hoveredNodeId;
        const isIncident =
          focusId != null &&
          (edge.sourceId === focusId || edge.targetId === focusId);
        color = isIncident ? communityColor(src.node.community) : THEME.edge;
        alpha = isIncident ? 0.62 : 0.02;
        width = isIncident ? 1.8 : 0.35;
        category = isIncident ? 1 : 0;
      } else {
        const srcNode = this.nodeMap.get(edge.sourceId);
        color = srcNode ? communityColor(srcNode.node.community) : THEME.edge;
        const isHosts = edge.relation === 'hosts';
        alpha = isHosts ? 0.06 : 0.12;
        width = isHosts ? 0.45 : 1.2;
        category = isHosts ? 1 : 0;
        // Tier-based edge declutter: fade edges involving low-tier nodes
        const worstTier = Math.max(src.tier, tgt.tier);
        if (worstTier >= 3) alpha *= 0.15;
      }

      const key = color * 2 + category;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { color, alpha, width, indices: [] };
        buckets.set(key, bucket);
      }
      bucket.indices.push(i);
    }

    // Issue one stroke() per bucket
    const stride = this.lodStride;
    for (const [, bucket] of buckets) {
      for (const i of bucket.indices) {
        this.traceBundledEdge(g, this.bundledPaths[i], stride);
      }
      g.stroke({
        color: bucket.color,
        alpha: bucket.alpha,
        width: bucket.width,
        cap: 'round',
        join: 'round',
      });
    }
  }

  /** Fast straight-line edges (used during simulation when bundling is off). */
  private drawEdgesStraight(
    g: Graphics,
    connected: Set<string> | null,
    focusNodeId: string | null = null,
    dedupeIncidentForFocus = false,
    curvedIncidentForFocus = false,
  ): void {
    // Batch by style key
    const buckets = new Map<
      string,
      {
        color: number;
        alpha: number;
        width: number;
        edges: {
          sx: number;
          sy: number;
          tx: number;
          ty: number;
          cpx?: number;
          cpy?: number;
        }[];
      }
    >();

    // Keep at most one highlighted edge per focused-node neighbor.
    let keepIncident: Set<number> | null = null;
    if (connected && focusNodeId && dedupeIncidentForFocus) {
      const bestByNeighbor = new Map<string, { idx: number; weight: number }>();
      for (let i = 0; i < this.edges.length; i++) {
        const edge = this.edges[i];
        const otherId =
          edge.sourceId === focusNodeId
            ? edge.targetId
            : edge.targetId === focusNodeId
              ? edge.sourceId
              : null;
        if (!otherId) continue;

        const prev = bestByNeighbor.get(otherId);
        if (!prev || edge.weight > prev.weight) {
          bestByNeighbor.set(otherId, { idx: i, weight: edge.weight });
        }
      }
      keepIncident = new Set<number>();
      for (const v of bestByNeighbor.values()) keepIncident.add(v.idx);
    }

    for (let edgeIdx = 0; edgeIdx < this.edges.length; edgeIdx++) {
      const edge = this.edges[edgeIdx];
      const src = this.nodeMap.get(edge.sourceId);
      const tgt = this.nodeMap.get(edge.targetId);
      if (!src || !tgt) continue;

      // Viewport cull
      if (!this.edgeInView(src.node.x, src.node.y, tgt.node.x, tgt.node.y)) continue;

      // Skip edges where either endpoint is not visible (tier-based)
      if (src.graphic.alpha < 0.1 || tgt.graphic.alpha < 0.1) continue;

      let color = communityColor(src.node.community);
      let alpha: number, width: number;
      let cpx: number | undefined;
      let cpy: number | undefined;
      if (connected || this.hoverConnectedSet) {
        const focusId = focusNodeId || this.hoveredNodeId;
        const isIncident =
          focusId != null &&
          (edge.sourceId === focusId || edge.targetId === focusId);
        if (isIncident && keepIncident && !keepIncident.has(edgeIdx)) {
          continue;
        }

        if (isIncident && curvedIncidentForFocus) {
          const dx = tgt.node.x - src.node.x;
          const dy = tgt.node.y - src.node.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const nx = -dy / dist;
          const ny = dx / dist;
          const mx = (src.node.x + tgt.node.x) / 2;
          const my = (src.node.y + tgt.node.y) / 2;

          // Deterministic side selection so curves are stable frame-to-frame.
          const edgeKey =
            edge.sourceId < edge.targetId
              ? `${edge.sourceId}|${edge.targetId}`
              : `${edge.targetId}|${edge.sourceId}`;
          let h = 0;
          for (let i = 0; i < edgeKey.length; i++) {
            h = (Math.imul(31, h) + edgeKey.charCodeAt(i)) | 0;
          }
          const parity = (h & 1) === 0 ? 1 : -1;
          const offset = Math.min(26, Math.max(8, dist * 0.12));
          cpx = mx + nx * offset * parity;
          cpy = my + ny * offset * parity;
        }

        color = isIncident ? color : THEME.edge;
        alpha = isIncident ? 0.75 : 0.03;
        width = isIncident ? 1.5 : 0.4;
      } else {
        const isHosts = edge.relation === 'hosts';
        alpha = isHosts ? 0.06 : 0.1;
        width = isHosts ? 0.45 : 0.75;
        // Tier-based edge declutter: fade edges involving low-tier nodes
        const worstTier = Math.max(src.tier, tgt.tier);
        if (worstTier >= 3) alpha *= 0.15;
      }

      const key = `${color}_${alpha}_${width}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { color, alpha, width, edges: [] };
        buckets.set(key, bucket);
      }
      bucket.edges.push({
        sx: src.node.x,
        sy: src.node.y,
        tx: tgt.node.x,
        ty: tgt.node.y,
        cpx,
        cpy,
      });
    }

    for (const [, bucket] of buckets) {
      for (const e of bucket.edges) {
        g.moveTo(e.sx, e.sy);
        if (e.cpx != null && e.cpy != null) {
          g.quadraticCurveTo(e.cpx, e.cpy, e.tx, e.ty);
        } else {
          g.lineTo(e.tx, e.ty);
        }
      }
      g.stroke({
        color: bucket.color,
        alpha: bucket.alpha,
        width: bucket.width,
        cap: 'round',
        join: 'round',
      });
    }
  }


  // ── Private: Interaction ─────────────────────────────────────────────────

  private setupInteraction(): void {
    const canvas = this.app.canvas as HTMLCanvasElement;

    // Wheel zoom
    this.boundWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      this.zoomAt(sx, sy, factor);
    };
    canvas.addEventListener('wheel', this.boundWheel, { passive: false });

    // Pointer drag for pan + click hit-test
    this.boundPointerDown = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      this.dragging = true;
      this.dragStartX = sx;
      this.dragStartY = sy;
      this.camStartX = this.camX;
      this.camStartY = this.camY;
      canvas.setPointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerdown', this.boundPointerDown);

    this.boundPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (this.dragging) {
        const dx = sx - this.dragStartX;
        const dy = sy - this.dragStartY;
        this.camX = this.camStartX - dx / this.camScale;
        this.camY = this.camStartY - dy / this.camScale;
        this.scheduleCameraUpdate();
        return;
      }

      // Hover hit-test
      const world = this.screenToWorld(sx, sy);
      const hit = this.hitTest(world.x, world.y);
      if (hit !== this.hoveredNodeId) {
        this.hoveredNodeId = hit;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        this.onNodeHover?.(hit);

        // Build hover neighborhood
        if (this.hoverDimRafId) {
          cancelAnimationFrame(this.hoverDimRafId);
          this.hoverDimRafId = 0;
        }
        if (hit) {
          const neighbors = new Set<string>([hit]);
          for (const edge of this.edges) {
            if (edge.sourceId === hit) neighbors.add(edge.targetId);
            if (edge.targetId === hit) neighbors.add(edge.sourceId);
          }
          this.hoverConnectedSet = neighbors;
          // Cap hover labels: hovered node + closest N neighbors
          const MAX_HOVER_LABELS = 8;
          const hEntry = this.nodeMap.get(hit);
          const hx = hEntry?.node.x ?? 0, hy = hEntry?.node.y ?? 0;
          const neighborIds = [...neighbors].filter(id => id !== hit);
          const labelCandidates = neighborIds
            .map(id => this.nodeMap.get(id))
            .filter((e): e is NodeEntry => e != null)
            .sort((a, b) => {
              const da = (a.node.x - hx) ** 2 + (a.node.y - hy) ** 2;
              const db = (b.node.x - hx) ** 2 + (b.node.y - hy) ** 2;
              return da - db;
            })
            .slice(0, MAX_HOVER_LABELS);
          this.hoverLabelSet = new Set([hit, ...labelCandidates.map(e => e.node.id)]);
          this.hoverStartTime = performance.now();
          // Schedule deferred dimming after delay
          this.scheduleDeferredDim();
        } else {
          this.hoverConnectedSet = null;
          this.hoverLabelSet = null;
          this.hoverStartTime = 0;
          // Animate scale-down transition
          this.scheduleHoverScaleDown();
        }
        this.cullNodes();
        this.edgeCacheKey = null; // force edge redraw for hover state
        this.edgesDirty = true;
        this.ensureTickerFlush();
      }
    };
    canvas.addEventListener('pointermove', this.boundPointerMove);

    this.boundPointerUp = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      canvas.releasePointerCapture(e.pointerId);

      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // If the pointer barely moved, treat as a click
      const dx = sx - this.dragStartX;
      const dy = sy - this.dragStartY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 4) {
        const world = this.screenToWorld(sx, sy);
        const hit = this.hitTest(world.x, world.y);
        if (hit) {
          this.onNodeClick?.(hit);
        } else {
          this.onBackgroundClick?.();
        }
      }
    };
    canvas.addEventListener('pointerup', this.boundPointerUp);
  }

  private hitTest(wx: number, wy: number): string | null {
    // Iterate nodes and check distance within radius+4
    for (const [id, entry] of this.nodeMap) {
      const dx = wx - entry.node.x;
      const dy = wy - entry.node.y;
      const hitR = entry.radius + 4;
      if (dx * dx + dy * dy <= hitR * hitR) {
        return id;
      }
    }
    return null;
  }

  // ── Private: Camera ──────────────────────────────────────────────────────

  private prevLodStride = 1;
  /** Quantized camScale — edge rebuild triggered when tier visibility changes. */
  private prevTierBucket = 0;

  private applyCamera(): void {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    this.viewport.x = w / 2 - this.camX * this.camScale;
    this.viewport.y = h / 2 - this.camY * this.camScale;
    this.viewport.scale.set(this.camScale, this.camScale);
    this.updateDotTiling();
    this.cullNodes();
    // LOD stride or tier visibility changed — trigger edge rebuild
    const stride = this.lodStride;
    const tierBucket = Math.round(this.camScale * 20); // quantize to 0.05 steps
    const needsEdgeRebuild = stride !== this.prevLodStride || tierBucket !== this.prevTierBucket;
    this.prevLodStride = stride;
    this.prevTierBucket = tierBucket;
    if (needsEdgeRebuild) {
      this.edgeCacheKey = null;
      this.edgesDirty = true;
      this.ensureTickerFlush();
    }
    this.onCameraMove?.();
  }

  /** Coalesce high-frequency camera updates (wheel/drag) into one rAF. */
  private scheduleCameraUpdate(): void {
    if (!this.cameraDirty) {
      this.cameraDirty = true;
      this.cameraRafId = requestAnimationFrame(() => {
        this.cameraDirty = false;
        this.applyCamera();
      });
    }
  }

  /** Lazily attach a Pixi ticker callback that flushes dirty edges/hulls. */
  private ensureTickerFlush(): void {
    if (this.tickerBound) return;
    this.tickerBound = true;
    this.app.ticker.add(this.flushDirty, this);
  }

  /** Ticker callback — flush deferred edge/hull redraws (max once per frame). */
  private flushDirty(): void {
    if (this.edgesDirty) {
      this.edgesDirty = false;
      if (this.highlightedSet && this.highlightedNodeId) {
        this.drawEdgesHighlighted(this.highlightedNodeId, this.highlightedSet);
      } else {
        this.drawEdges();
      }
    }
    if (this.hullsDirty) {
      this.hullsDirty = false;
      this.drawHulls();
    }
  }

  // ── Private: Dot grid background (TilingSprite — one draw call) ──────────

  private initDotTiling(): void {
    const sp = KgRenderer.DOT_SPACING;
    const dpr = window.devicePixelRatio || 1;
    const tileSize = sp * dpr;

    // Render one dot into a tiny canvas
    const c = document.createElement('canvas');
    c.width = tileSize;
    c.height = tileSize;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = `rgba(42,41,48,0.5)`; // THEME.dotGrid @ 0.5 alpha
    ctx.beginPath();
    ctx.arc(tileSize / 2, tileSize / 2, 0.8 * dpr, 0, Math.PI * 2);
    ctx.fill();

    const tex = Texture.from({ resource: c, resolution: dpr });
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    this.dotTiling = new TilingSprite({ texture: tex, width: w, height: h });
    // Insert behind everything else in the stage
    this.app.stage.addChildAt(this.dotTiling, 0);
  }

  private updateDotTiling(): void {
    const dt = this.dotTiling;
    if (!dt) return;
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    dt.width = w;
    dt.height = h;

    const sp = KgRenderer.DOT_SPACING;
    dt.tileScale.set(this.camScale, this.camScale);
    // Offset so dots track world-space grid during pan
    const offX = (w / 2 - this.camX * this.camScale) % (sp * this.camScale);
    const offY = (h / 2 - this.camY * this.camScale) % (sp * this.camScale);
    dt.tilePosition.set(offX, offY);
  }

  // ── Private: Node + label culling ────────────────────────────────────────

  /** Hide nodes and labels that are off-screen; merge label-visibility logic. */
  private cullNodes(): void {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const margin = 60; // screen-space margin

    for (const [, entry] of this.nodeMap) {
      // World → screen
      const sx = (entry.node.x - this.camX) * this.camScale + w / 2;
      const sy = (entry.node.y - this.camY) * this.camScale + h / 2;
      const inView = sx >= -margin && sx <= w + margin && sy >= -margin && sy <= h + margin;

      if (!inView) {
        entry.graphic.renderable = false;
        entry.label.renderable = false;
        continue;
      }

      // Tier-based visibility
      const dotOp = this.tierDotOp2D(entry.tier);
      const labelOp = this.tierLabelOp2D(entry.tier);

      entry.graphic.renderable = dotOp >= 0.05;
      entry.graphic.alpha = dotOp;
      entry.graphic.tint = 0xffffff; // reset tint
      entry.label.renderable = labelOp > 0.05;
      entry.label.alpha = labelOp;
      entry.label.tint = 0xffffff;

      // Hover neighborhood override
      // Neighbors highlight instantly; non-neighbors dim after delay
      if (this.hoverConnectedSet) {
        const HOVER_DIM_DELAY = 400;
        const elapsed = performance.now() - this.hoverStartTime;
        const dimStrength = elapsed > HOVER_DIM_DELAY
          ? Math.min(1, (elapsed - HOVER_DIM_DELAY) / 300) : 0;

        if (this.hoverConnectedSet.has(entry.node.id)) {
          entry.graphic.alpha = 1;
          entry.graphic.renderable = true;
          const isHoveredNode = entry.node.id === this.hoveredNodeId;
          if (isHoveredNode) {
            entry.graphic.tint = 0xF0A070; // warm accent for hovered node
            entry.label.tint = 0xF0A070;
          } else {
            entry.graphic.tint = 0xF0856A; // warm tint for neighbors
            entry.label.tint = 0xF0856A;
          }
          if (this.hoverLabelSet && this.hoverLabelSet.has(entry.node.id)) {
            // Hovered node label is instant; neighbor labels fade in with dimming
            entry.label.alpha = isHoveredNode ? 1 : labelOp + (1 - labelOp) * dimStrength;
            entry.label.renderable = true;
          }
        } else if (dimStrength > 0) {
          const factor = 1.0 - dimStrength * 0.82; // fades to 0.18
          entry.graphic.alpha *= factor;
          entry.label.alpha *= factor;
        } else if (this.highlightedSet && !this.highlightedSet.has(entry.node.id)) {
          // During delay, preserve selection dimming for non-neighbors
          entry.graphic.alpha = THEME.fadeAlpha;
          entry.label.alpha = THEME.fadeAlpha;
        }
      }

      // Highlight override (selection, when no hover active)
      if (this.highlightedSet) {
        if (this.highlightedSet.has(entry.node.id)) {
          entry.graphic.alpha = 1;
          entry.graphic.renderable = true;
          // Only show labels for capped selection label set
          if (this.selectionLabelSet && this.selectionLabelSet.has(entry.node.id)) {
            entry.label.alpha = 1;
            entry.label.renderable = true;
          }
          // Tint selected node and its neighbors
          if (entry.node.id === this.highlightedNodeId) {
            entry.graphic.tint = 0xF05060;
            entry.label.tint = 0xF05060;
          } else {
            entry.graphic.tint = 0xF09080;
            entry.label.tint = 0xF09080;
          }
        } else if (!this.hoverConnectedSet) {
          entry.graphic.alpha = THEME.fadeAlpha;
          entry.label.alpha = THEME.fadeAlpha;
        }
      }

      // Smooth hover scale transitions
      const isHoveredNode = entry.node.id === this.hoveredNodeId;
      const isSelectedNode = entry.node.id === this.highlightedNodeId;
      const dotScaleTarget = isHoveredNode ? 1.6 : 1.0;
      const labelScaleTarget = isHoveredNode ? 1.5 : 1.0;
      entry.hoverDotScale += (dotScaleTarget - entry.hoverDotScale) * 0.18;
      entry.hoverLabelScale += (labelScaleTarget - entry.hoverLabelScale) * 0.18;
      // Snap when close enough
      if (Math.abs(entry.hoverDotScale - dotScaleTarget) < 0.005) entry.hoverDotScale = dotScaleTarget;
      if (Math.abs(entry.hoverLabelScale - labelScaleTarget) < 0.005) entry.hoverLabelScale = labelScaleTarget;
      entry.graphic.scale.set(entry.hoverDotScale);

      // Hovered/selected: full opacity and on top of everything
      if (isHoveredNode || isSelectedNode) {
        entry.graphic.alpha = 1;
        entry.label.alpha = 1;
        entry.label.renderable = true;
        entry.graphic.renderable = true;
        entry.graphic.zIndex = isHoveredNode ? 100 : 99;
        entry.label.zIndex = isHoveredNode ? 100 : 99;
      } else {
        entry.graphic.zIndex = 0;
        entry.label.zIndex = 0;
      }

      // Clamp all visible labels to minimum readable screen size
      // (must run AFTER hover/selection overrides that may set renderable=true)
      if (entry.label.renderable) {
        const minScreenPx = 18;
        const screenSize = LABEL_FONT_SIZE * this.camScale;
        if (screenSize < minScreenPx) {
          entry.label.scale.set((minScreenPx / screenSize) * entry.hoverLabelScale / LABEL_OVERSAMPLE);
        } else {
          entry.label.scale.set(entry.hoverLabelScale / LABEL_OVERSAMPLE);
        }
      }
    }
  }

  // ── Private: Resize ──────────────────────────────────────────────────────

  private handleResize(): void {
    const rect = this.containerEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.app.renderer.resize(rect.width, rect.height);
      this.updateDotTiling();
      this.applyCamera();
    }
  }

  // ── Private: Cluster hulls ──────────────────────────────────────────────

  /** Hash of node positions — skip hull rebuild when positions are stable. */
  private hullPosHash = 0;

  private drawHulls(): void {
    // Quick position hash — if positions haven't changed, skip rebuild
    let posHash = 0;
    for (const [, entry] of this.nodeMap) {
      // Combine x/y into a single running hash (integer-truncated coordinates)
      posHash = (Math.imul(posHash ^ (entry.node.x * 1000 | 0), 0x9e3779b9) + (entry.node.y * 1000 | 0)) | 0;
    }
    if (posHash === this.hullPosHash) return;
    this.hullPosHash = posHash;

    const g = this.hullGraphics;
    g.clear();

    // Group nodes by Louvain community (emergent clustering)
    const groups = new Map<number, { x: number; y: number }[]>();
    for (const [, entry] of this.nodeMap) {
      const comm = entry.node.community;
      if (comm == null) continue;
      let pts = groups.get(comm);
      if (!pts) { pts = []; groups.set(comm, pts); }
      pts.push({ x: entry.node.x, y: entry.node.y });
    }

    const pad = 50; // pixels of padding around the hull

    for (const [comm, pts] of groups) {
      if (pts.length < 3) continue;

      const hull = expandHull(convexHull(pts), pad);
      if (hull.length < 3) continue;

      const color = communityColor(comm);

      // Draw rounded hull using smooth curve through vertices
      g.moveTo(
        (hull[hull.length - 1].x + hull[0].x) / 2,
        (hull[hull.length - 1].y + hull[0].y) / 2,
      );
      for (let i = 0; i < hull.length; i++) {
        const curr = hull[i];
        const next = hull[(i + 1) % hull.length];
        const mx = (curr.x + next.x) / 2;
        const my = (curr.y + next.y) / 2;
        g.quadraticCurveTo(curr.x, curr.y, mx, my);
      }
      g.closePath();
      g.fill({ color, alpha: 0.03 });
      g.stroke({ color, alpha: 0.06, width: 1 });
    }
  }

  // ── Private: Deferred hover dimming ─────────────────────────────────────

  /** Animate the hover dim fade-in after the delay. */
  private scheduleDeferredDim(): void {
    const HOVER_DIM_DELAY = 400;
    const FADE_DURATION = 300;
    const step = () => {
      if (!this.hoverConnectedSet) return;
      this.cullNodes();
      this.edgeCacheKey = null;
      this.edgesDirty = true;
      this.ensureTickerFlush();
      const elapsed = performance.now() - this.hoverStartTime;
      if (elapsed < HOVER_DIM_DELAY + FADE_DURATION) {
        this.hoverDimRafId = requestAnimationFrame(step);
      } else {
        this.hoverDimRafId = 0;
      }
    };
    // Start checking after the delay
    setTimeout(() => {
      if (!this.hoverConnectedSet) return;
      this.hoverDimRafId = requestAnimationFrame(step);
    }, HOVER_DIM_DELAY);
  }

  /** Animate hover dot/label scale back to 1.0 over a few frames. */
  private scheduleHoverScaleDown(): void {
    let frames = 0;
    const step = () => {
      let anyAnimating = false;
      for (const [, entry] of this.nodeMap) {
        if (Math.abs(entry.hoverDotScale - 1) > 0.005 || Math.abs(entry.hoverLabelScale - 1) > 0.005) {
          anyAnimating = true;
          break;
        }
      }
      if (anyAnimating && frames < 30) {
        frames++;
        this.cullNodes();
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }

  // ── Private: Tier assignment ────────────────────────────────────────────

  private assignTiers(): void {
    const maxFreq = Math.max(1, ...this.nodes.map(n => n.frequency ?? 1));
    const nodeIntensities = new Map<string, number>();
    for (const node of this.nodes) {
      const msgNorm = (node.frequency ?? 1) / maxFreq;
      nodeIntensities.set(node.id, 0.2 + 0.8 * Math.sqrt(msgNorm));
    }

    const n = this.nodes.length;
    let t1Pct = 0.05, t2Pct = 0.20;
    if (n < 50) { t1Pct = 0.15; t2Pct = 0.40; }
    else if (n < 100) { t1Pct = 0.10; t2Pct = 0.30; }

    const totalT1 = Math.max(1, Math.round(n * t1Pct));
    const totalT2 = Math.max(1, Math.round(n * t2Pct));

    // Group by community, sorted by intensity within each
    const communities = new Map<number, RendererNode[]>();
    const noCommunity: RendererNode[] = [];
    for (const node of this.nodes) {
      if (node.community != null) {
        let arr = communities.get(node.community);
        if (!arr) { arr = []; communities.set(node.community, arr); }
        arr.push(node);
      } else {
        noCommunity.push(node);
      }
    }
    const allGroups = [...communities.values()];
    if (noCommunity.length > 0) allGroups.push(noCommunity);

    for (const group of allGroups) {
      group.sort((a, b) => (nodeIntensities.get(b.id) ?? 0) - (nodeIntensities.get(a.id) ?? 0));
    }

    const FORCE_T1_TOKENS = ['provider', 'topic'];

    // Distribute tier slots proportionally across communities
    for (const group of allGroups) {
      const cn = group.length;
      const c1 = Math.max(1, Math.round((cn / n) * totalT1));
      const c2 = Math.max(1, Math.round((cn / n) * totalT2));

      for (let i = 0; i < cn; i++) {
        const node = group[i];
        const candidates = [node.entity_type, node.node_type].filter(Boolean).map(s => s!.toLowerCase());
        const forced = candidates.some(c => FORCE_T1_TOKENS.some(t => c.includes(t)));
        const tier: 1 | 2 | 3 = forced || i < c1 ? 1 : i < c2 ? 2 : 3;
        const entry = this.nodeMap.get(node.id);
        if (entry) entry.tier = tier;
      }
    }
  }

  // ── Private: Clear ───────────────────────────────────────────────────────

  private clearAllGraphics(): void {
    // Remove all node graphics
    this.nodeLayer.removeChildren();
    // Remove all labels
    this.labelLayer.removeChildren();
    // Clear edge graphics
    this.edgeGraphics.clear();
    // Clear hull graphics
    this.hullGraphics.clear();
    // Clear bookkeeping
    this.nodeMap.clear();
    this.nodes = [];
    this.edges = [];
    this.bundledPaths = [];
    this.bundleDirty = true;
    this.edgeCacheKey = null;
    this.hullPosHash = 0;
    this.highlightedSet = null;
    this.selectionLabelSet = null;
    this.highlightedNodeId = null;
    this.fadedSet = null;
    this.hoveredNodeId = null;
    this.hoverConnectedSet = null;
    this.hoverLabelSet = null;
  }

  // ── Private: Glow helpers ────────────────────────────────────────────────

  private removeGlow(): void {
    if (this.glowGraphics) {
      this.glowGraphics.removeFromParent();
      this.glowGraphics.destroy();
      this.glowGraphics = null;
    }
  }

  // ── Private: Fade helpers ────────────────────────────────────────────────

  private applyFadeSet(): void {
    if (!this.fadedSet) return;
    for (const [id, entry] of this.nodeMap) {
      if (this.fadedSet.has(id)) {
        entry.graphic.alpha = THEME.fadeAlpha;
        entry.label.alpha = THEME.fadeAlpha;
      }
    }
  }
}
