import * as THREE from "three";

// ── Shader sources ──────────────────────────────────────────

export const vertShader = `
  varying vec3 vNormal, vViewDir, vObjPos;
  void main() {
    vObjPos = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

export const fragShader = `
  uniform float uTime, uIntensity, uOpacity, uHover, uHighlight;
  uniform vec3 uGroupColor;
  varying vec3 vNormal, vViewDir, vObjPos;
  void main() {
    vec3 N = normalize(vNormal), V = normalize(vViewDir);
    float NdV = max(dot(N, V), 0.0);
    float fresnel = pow(1.0 - NdV, 2.5);
    vec3 cA = vec3(0.65,0.88,1.0), cB = vec3(0.73,0.91,1.0), cC = vec3(0.82,0.95,1.0), cD = vec3(0.50,0.78,0.94);
    float tintStrength = 0.72;
    cA = mix(cA, uGroupColor, tintStrength);
    cB = mix(cB, uGroupColor * 1.1, tintStrength * 0.85);
    cC = mix(cC, uGroupColor * 1.2 + 0.1, tintStrength * 0.6);
    cD = mix(cD, uGroupColor * 0.8, tintStrength * 0.7);
    float faceTint = dot(N, normalize(vec3(0.3,1.0,0.5)))*0.5+0.5;
    vec3 interior = mix(cA, cB, faceTint);
    interior = mix(interior, cD, (1.0-faceTint)*0.3*(1.0-uIntensity*0.5));
    interior = mix(interior*0.6, interior, 0.5+uIntensity*0.5);
    vec3 surface = cC*0.3;
    vec3 lD = normalize(vec3(0.4,1.0,0.6));
    float wrap = smoothstep(-0.4, 0.8, dot(N,lD));
    float bg = max(0.0, -dot(N,lD))*0.15;
    vec3 lit = interior*(0.55+wrap*0.45); lit += cC*bg*uIntensity;
    vec3 color = mix(lit, surface+cC*0.1, fresnel*0.5);
    color += cB*fresnel*(0.15+uIntensity*0.2);
    vec3 H = normalize(V+lD); color += cC*pow(max(dot(N,H),0.0),12.0)*0.2*uIntensity;
    float pulse = 0.05+0.015*sin(uTime*2.5);
    color += cC*uHover*pulse; color += cB*uHover*0.04*(1.0-fresnel);
    // Highlight: shift toward warm crimson-rose accent with glow
    vec3 hlAccent = vec3(0.94, 0.31, 0.38);
    color = mix(color, hlAccent * (0.7 + 0.3 * fresnel), uHighlight * 0.55);
    color += hlAccent * uHighlight * 0.10 * (1.0 + fresnel);
    float alpha = uOpacity*(0.5+uIntensity*0.4+fresnel*0.2 + uHighlight*0.25);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }`;

export const textVert = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

export const textFrag = `
  uniform sampler2D uTex;
  uniform float uOpacity, uHover, uHighlight;
  uniform vec3 uGroupColor;
  varying vec2 vUv;
  void main() {
    vec4 texel = texture2D(uTex, vUv);
    if (texel.a < 0.1) discard;
    vec3 baseColor = mix(vec3(0.76, 0.93, 1.0), uGroupColor, 0.58);
    baseColor = mix(baseColor, vec3(1.0), 0.2);
    baseColor += vec3(0.06) * uHover;
    // Highlight: shift toward warm crimson-rose accent
    vec3 hlAccent = vec3(0.94, 0.31, 0.38);
    baseColor = mix(baseColor, hlAccent, uHighlight * 0.5);
    baseColor += vec3(0.06) * uHighlight;
    float alpha = texel.a * uOpacity;
    gl_FragColor = vec4(baseColor, alpha);
  }`;

// ── Geometry helpers ──────────────────────────────────────────

export function createRoundedBox(size: number, radius: number, detail: number) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const s = size / 2, r = Math.min(radius, s * 0.95), inner = s - r;
  for (let i = 0; i < pos.count; i++) {
    let dx = pos.getX(i), dy = pos.getY(i), dz = pos.getZ(i);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const eps = 1e-8;
    const tBox = Math.min(s / (Math.abs(dx) + eps), s / (Math.abs(dy) + eps), s / (Math.abs(dz) + eps));
    const bx = dx * tBox, by = dy * tBox, bz = dz * tBox;
    const cx = Math.max(-inner, Math.min(inner, bx));
    const cy = Math.max(-inner, Math.min(inner, by));
    const cz = Math.max(-inner, Math.min(inner, bz));
    let nx = bx - cx, ny = by - cy, nz = bz - cz;
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nLen > 1e-6) {
      nx /= nLen; ny /= nLen; nz /= nLen;
      pos.setXYZ(i, cx + nx * r, cy + ny * r, cz + nz * r);
      nor.setXYZ(i, nx, ny, nz);
    } else {
      pos.setXYZ(i, bx, by, bz);
      const ax = Math.abs(bx), ay = Math.abs(by), az = Math.abs(bz);
      if (ax >= ay && ax >= az) nor.setXYZ(i, Math.sign(bx), 0, 0);
      else if (ay >= ax && ay >= az) nor.setXYZ(i, 0, Math.sign(by), 0);
      else nor.setXYZ(i, 0, 0, Math.sign(bz));
    }
  }
  pos.needsUpdate = true; nor.needsUpdate = true; geo.computeBoundingSphere();
  return geo;
}

export type NodeShapeKind = "roundedBox" | "sphere" | "tetrahedron" | "dodecahedron" | "box";

export interface NodeVisualSpec {
  shape: NodeShapeKind;
  color: THREE.Vector3;
  key: string;
  scale: number;
  tiltX: number;
  tiltZ: number;
}

const NODE_VISUAL_PRESETS: {
  shape: NodeShapeKind;
  color: [number, number, number];
  scale: number;
  tiltX: number;
  tiltZ: number;
}[] = [
  { shape: "roundedBox", color: [0.47, 0.81, 1.0], scale: 1.0, tiltX: Math.PI * 0.04, tiltZ: 0 },
  { shape: "sphere", color: [0.56, 0.93, 0.76], scale: 1.18, tiltX: 0, tiltZ: 0 },
  { shape: "tetrahedron", color: [0.98, 0.64, 0.78], scale: 1.5, tiltX: Math.PI * 0.18, tiltZ: Math.PI * 0.08 },
  { shape: "box", color: [0.96, 0.82, 0.48], scale: 1.4, tiltX: Math.PI * 0.12, tiltZ: Math.PI * 0.08 },
];

const NODE_VISUAL_OVERRIDES: { tokens: string[]; presetIndex: number }[] = [
  { tokens: ["provider"], presetIndex: 2 },
  { tokens: ["topic"], presetIndex: 3 },
  { tokens: ["thread", "conversation", "chat", "message"], presetIndex: 1 },
  { tokens: ["document", "file", "note", "page"], presetIndex: 0 },
  { tokens: ["relation", "edge", "link", "triple"], presetIndex: 2 },
];

function hashText(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeNodeVisualCandidates(node: Pick<NodeDef, "entityType" | "nodeType" | "protocol" | "status" | "id">) {
  return [node.entityType, node.nodeType, node.protocol, node.status, node.id]
    .filter((value): value is string => !!value)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function getNodeVisualSpec(node: Pick<NodeDef, "entityType" | "nodeType" | "protocol" | "status" | "id">): NodeVisualSpec {
  const candidates = normalizeNodeVisualCandidates(node);

  for (const candidate of candidates) {
    for (const override of NODE_VISUAL_OVERRIDES) {
      if (override.tokens.some((token) => candidate.includes(token))) {
        const preset = NODE_VISUAL_PRESETS[override.presetIndex];
        return {
          shape: preset.shape,
          color: new THREE.Vector3(...preset.color),
          key: candidate,
          scale: preset.scale,
          tiltX: preset.tiltX,
          tiltZ: preset.tiltZ,
        };
      }
    }
  }

  const key = candidates[0] || "default";
  const preset = NODE_VISUAL_PRESETS[hashText(key) % NODE_VISUAL_PRESETS.length];
  return {
    shape: preset.shape,
    color: new THREE.Vector3(...preset.color),
    key,
    scale: preset.scale,
    tiltX: preset.tiltX,
    tiltZ: preset.tiltZ,
  };
}

// ── Tier visibility system ──────────────────────────────────

/** Tier visibility thresholds for the 3D renderer (dZ-based).
 *  Dots are always visible (no zoom gating) — only opacity varies by tier.
 *  Labels use zoom-gated progressive disclosure. */
export const TIER_THRESHOLDS = {
  1: { dot: { start: Infinity, end: Infinity, maxOp: 1.0 }, label: { start: Infinity, end: Infinity, maxOp: 1.0 } },
  2: { dot: { start: Infinity, end: Infinity, maxOp: 0.55 }, label: { start: 12, end: 8, maxOp: 0.8 } },
  3: { dot: { start: Infinity, end: Infinity, maxOp: 0.3 }, label: { start: 6, end: 3, maxOp: 0.6 } },
} as const;

/**
 * Smoothstep with intentionally reversed edges: as x decreases below edge0
 * (camera zooming in), output rises from 0 to 1.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Tier-based dot opacity for a given camera distance. */
export function tierDotOpacity(tier: 1 | 2 | 3, dZ: number): number {
  const th = TIER_THRESHOLDS[tier].dot;
  if (th.start === Infinity) return th.maxOp;
  return th.maxOp * smoothstep(th.start, th.end, dZ);
}

/** Tier-based label opacity for a given camera distance. */
export function tierLabelOpacity(tier: 1 | 2 | 3, dZ: number): number {
  const th = TIER_THRESHOLDS[tier].label;
  if (th.start === Infinity) return th.maxOp;
  return th.maxOp * smoothstep(th.start, th.end, dZ);
}

/**
 * Assign visibility tiers to nodes based on intensity rank.
 * Distributes Tier 1/2 slots proportionally across clusters so every
 * region of the graph has visible landmarks. Provider/topic nodes are
 * force-promoted to Tier 1.
 */
export function assignTiers(nodes: NodeDef[]): void {
  const n = nodes.length;
  if (n === 0) return;

  // Force-promote provider/topic nodes
  const FORCE_TIER1_TOKENS = ['provider', 'topic'];
  const forceT1 = new Set<number>();
  for (const def of nodes) {
    const candidates = [def.entityType, def.nodeType, def.protocol, def.status]
      .filter((v): v is string => !!v)
      .map(v => v.trim().toLowerCase());
    if (candidates.some(c => FORCE_TIER1_TOKENS.some(t => c.includes(t)))) {
      forceT1.add(def.idx);
    }
  }

  // Adaptive tier percentages for small graphs
  let t1Pct = 0.05, t2Pct = 0.20;
  if (n < 50) { t1Pct = 0.15; t2Pct = 0.40; }
  else if (n < 100) { t1Pct = 0.10; t2Pct = 0.30; }

  // Group by cluster, sorted by intensity within each cluster
  const clusters = new Map<number, NodeDef[]>();
  for (const def of nodes) {
    let arr = clusters.get(def.cluster);
    if (!arr) { arr = []; clusters.set(def.cluster, arr); }
    arr.push(def);
  }
  for (const [, arr] of clusters) {
    arr.sort((a, b) => b.intensity - a.intensity);
  }

  // Distribute tier slots proportionally across clusters
  const totalT1 = Math.max(1, Math.round(n * t1Pct));
  const totalT2 = Math.max(1, Math.round(n * t2Pct));

  for (const [, clusterNodes] of clusters) {
    const cn = clusterNodes.length;
    // Each cluster gets proportional slots, minimum 1 for Tier 1
    const c1 = Math.max(1, Math.round((cn / n) * totalT1));
    const c2 = Math.max(1, Math.round((cn / n) * totalT2));

    for (let i = 0; i < cn; i++) {
      const def = clusterNodes[i];
      if (forceT1.has(def.idx)) {
        def.tier = 1;
      } else if (i < c1) {
        def.tier = 1;
      } else if (i < c2) {
        def.tier = 2;
      } else {
        def.tier = 3;
      }
    }
  }

  // Ensure force-promoted nodes are Tier 1
  for (const def of nodes) {
    if (forceT1.has(def.idx)) def.tier = 1;
  }
}

function createRoundedTetrahedron(size: number, radius: number, detail: number) {
  const geo = new THREE.TetrahedronGeometry(1, detail);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;

  // Collect the 4 base tetrahedron vertices (before subdivision)
  const base = new THREE.TetrahedronGeometry(1, 0);
  const basePos = base.attributes.position as THREE.BufferAttribute;
  const verts: THREE.Vector3[] = [];
  for (let i = 0; i < basePos.count; i++) {
    const v = new THREE.Vector3(basePos.getX(i), basePos.getY(i), basePos.getZ(i));
    // Deduplicate
    if (!verts.some(e => e.distanceTo(v) < 0.01)) verts.push(v);
  }
  base.dispose();

  // For each edge pair, compute the edge line segment
  const edges: [THREE.Vector3, THREE.Vector3][] = [];
  for (let i = 0; i < verts.length; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      edges.push([verts[i], verts[j]]);
    }
  }

  void radius; // rounding controlled via subdivision detail level
  const scale = size * 0.82;

  for (let i = 0; i < pos.count; i++) {
    const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));

    // Find closest point on the "shrunken" tetrahedron skeleton
    // Shrink each face inward by radius, then project outward by radius
    // Simple approach: find closest edge/vertex, offset by radius along the normal

    // Normalize to unit tetrahedron surface
    const len = p.length() || 1;
    const dir = p.clone().divideScalar(len);

    // Find the closest edge
    let minEdgeDist = Infinity;
    for (const [a, b] of edges) {
      const ab = b.clone().sub(a);
      const ap = p.clone().sub(a);
      let t = ap.dot(ab) / ab.dot(ab);
      t = Math.max(0, Math.min(1, t));
      const closest = a.clone().add(ab.multiplyScalar(t));
      const dist = p.distanceTo(closest);
      if (dist < minEdgeDist) {
        minEdgeDist = dist;
      }
    }

    // Blend between original position and a sphere of same radius
    // More rounding near edges/vertices, less on face centers
    const edgeFactor = 1 - Math.min(1, minEdgeDist / 0.4);
    const blend = edgeFactor * 0.6; // How much to round

    // Spherical position at same radius
    const spherePos = dir.clone().multiplyScalar(len);
    // Blend: near edges → more sphere-like, on faces → keep flat
    const rounded = p.clone().lerp(spherePos, blend);

    pos.setXYZ(i, rounded.x * scale, rounded.y * scale, rounded.z * scale);
  }

  geo.computeVertexNormals();
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  geo.computeBoundingSphere();
  return geo;
}

export function createNodeShapeGeometry(shape: NodeShapeKind, size: number) {
  switch (shape) {
    case "sphere":
      return new THREE.SphereGeometry(size * 0.55, 16, 12);
    case "tetrahedron":
      return createRoundedTetrahedron(size, size * 0.2, 3);
    case "dodecahedron":
      return new THREE.DodecahedronGeometry(size * 0.68, 0);
    case "box":
      return createRoundedBox(size * 0.9, size * 0.22, 4);
    case "roundedBox":
    default:
      return createRoundedBox(size, size * 0.22, 4);
  }
}

export function makeIridMat(intensity: number, groupColor: THREE.Vector3) {
  return new THREE.ShaderMaterial({
    vertexShader: vertShader, fragmentShader: fragShader,
    uniforms: { uTime: { value: 0 }, uIntensity: { value: intensity }, uOpacity: { value: 0 }, uHover: { value: 0 }, uHighlight: { value: 0 }, uGroupColor: { value: groupColor || new THREE.Vector3(0.65, 0.88, 1.0) } },
    transparent: true, depthWrite: true, side: THREE.FrontSide,
  });
}

// Reuse a single offscreen canvas for all text textures to avoid ~1200 DOM element allocations
let _textCanvas: HTMLCanvasElement | null = null;
let _textCtx: CanvasRenderingContext2D | null = null;

export function makeTextTexture(text: string, intensity: number) {
  const scale = 2;
  const W = 512 * scale, H = 80 * scale;
  if (!_textCanvas) {
    _textCanvas = document.createElement("canvas");
    _textCanvas.width = W;
    _textCanvas.height = H;
    _textCtx = _textCanvas.getContext("2d")!;
  }
  const ctx = _textCtx!;
  ctx.clearRect(0, 0, W, H);
  const fontSize = Math.round((28 + intensity * 10) * scale);
  ctx.font = `500 ${fontSize}px 'DM Sans', sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(195, 236, 255, 1.0)";
  const maxW = W - 32 * scale;
  let label = text;
  if (ctx.measureText(label).width > maxW) {
    while (label.length > 1 && ctx.measureText(label + "\u2026").width > maxW) label = label.slice(0, -1);
    label += "\u2026";
  }
  ctx.fillText(label, W / 2, H / 2);
  // Copy pixels into a fresh ImageData so the shared canvas can be reused
  const imageData = ctx.getImageData(0, 0, W, H);
  const tex = new THREE.DataTexture(imageData.data, W, H, THREE.RGBAFormat);
  tex.flipY = true;
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export function makeTextMat(tex: THREE.Texture, _intensity: number, groupColor: THREE.Vector3) {
  return new THREE.ShaderMaterial({
    vertexShader: textVert, fragmentShader: textFrag,
    uniforms: { uTex: { value: tex }, uOpacity: { value: 0 }, uHover: { value: 0 }, uHighlight: { value: 0 }, uGroupColor: { value: groupColor || new THREE.Vector3(0.65, 0.88, 1.0) } },
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
  });
}

// ── Types ──────────────────────────────────────────────────

export interface NodeDef {
  pos: THREE.Vector3;
  intensity: number;
  tier: 1 | 2 | 3;
  cluster: number;
  birthTime: number;
  rotY: number;
  id: string;
  idx: number;
  protocol: string;
  status: string;
  connections: { target: number; relation?: string }[];
  // KG metadata
  entityId?: string;
  entityType?: string;
  nodeType?: string;
  frequency?: number;
  synonyms?: string[];
  threadCount?: number;
  neighborCount?: number;
  platform?: string;
  filePath?: string;
}

export interface ClusterDef {
  center: THREE.Vector3;
  birthTime: number;
  nodeCount: number;
  nodes: NodeDef[];
  name: string;
}

export interface SelectedNodeInfo {
  name: string;
  entityId: string;
  entityType: string;
  nodeType: string;
  cluster: string;
  frequency: number;
  intensity: number;
  synonyms: string[];
  threadCount: number;
  neighborCount: number;
  connections: { name: string; relation: string; entityType?: string; nodeType?: string; idx: number }[];
  platform?: string;
  filePath?: string;
}

// ── Convex hull ──────────────────────────────────────────────

export function convexHull2D(points2d: number[][]) {
  points2d.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: number[][] = [];
  for (const p of points2d) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: number[][] = [];
  for (let i = points2d.length - 1; i >= 0; i--) { const p = points2d[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
