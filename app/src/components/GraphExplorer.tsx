import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { cmdKgGetGraph, cmdKgIndexVault, getConversation, listConversations, isTauri } from "../lib/tauri-api";
import type { GraphData, GraphEdge, GraphNode } from "../lib/types";
import MarkdownRenderer from "./MarkdownRenderer";
import { parseFrontmatter, parseMessages } from "../lib/markdown";
import {
  assignTiers,
  convexHull2D,
  createNodeShapeGeometry,
  getNodeVisualSpec,
  makeIridMat,
  makeTextMat,
  makeTextTexture,
  tierDotOpacity,
  tierLabelOpacity,
  type ClusterDef,
  type NodeDef,
  type SelectedNodeInfo,
} from "./graphExplorerScene";
import type {
  GraphLayoutWorkerRequest,
  GraphLayoutWorkerResponse,
  SerializedTransformedData,
} from "./graph-layout-worker";

// ── Louvain community detection ──────────────────────────────

function louvainCommunities(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const nodeSet = new Set(nodes.map(n => n.id));
  const adj = new Map<string, Map<string, number>>();
  for (const n of nodes) adj.set(n.id, new Map());

  let totalWeight = 0;
  for (const e of edges) {
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target) || e.source === e.target) continue;
    const w = e.weight || 1;
    totalWeight += w;
    adj.get(e.source)!.set(e.target, (adj.get(e.source)!.get(e.target) || 0) + w);
    adj.get(e.target)!.set(e.source, (adj.get(e.target)!.get(e.source) || 0) + w);
  }

  // No edges → distribute into a few groups by hash
  if (totalWeight === 0) {
    const buckets = Math.max(1, Math.ceil(nodes.length / 6));
    const result = new Map<string, number>();
    nodes.forEach((n, i) => result.set(n.id, i % buckets));
    return result;
  }

  const community = new Map<string, number>();
  nodes.forEach((n, i) => community.set(n.id, i));

  const degree = new Map<string, number>();
  for (const n of nodes) {
    let d = 0;
    for (const w of (adj.get(n.id) || new Map()).values()) d += w;
    degree.set(n.id, d);
  }

  const commDegree = new Map<number, number>();
  for (const n of nodes) {
    const c = community.get(n.id)!;
    commDegree.set(c, (commDegree.get(c) || 0) + degree.get(n.id)!);
  }

  let improved = true;
  let iterations = 0;
  while (improved && iterations < 15) {
    improved = false;
    iterations++;
    for (const node of nodes) {
      const nodeId = node.id;
      const currentComm = community.get(nodeId)!;
      const ki = degree.get(nodeId)!;
      const commConnections = new Map<number, number>();
      for (const [neighbor, w] of (adj.get(nodeId) || new Map())) {
        const nc = community.get(neighbor)!;
        commConnections.set(nc, (commConnections.get(nc) || 0) + w);
      }
      let bestComm = currentComm;
      let bestGain = 0;
      const kiIn = commConnections.get(currentComm) || 0;
      for (const [targetComm, kiTarget] of commConnections) {
        if (targetComm === currentComm) continue;
        const sigmaTot = commDegree.get(targetComm)!;
        const sigmaTotOwn = commDegree.get(currentComm)! - ki;
        const gain = (kiTarget - kiIn) / totalWeight - ki * (sigmaTot - sigmaTotOwn) / (2 * totalWeight * totalWeight);
        if (gain > bestGain) { bestGain = gain; bestComm = targetComm; }
      }
      if (bestComm !== currentComm) {
        community.set(nodeId, bestComm);
        commDegree.set(currentComm, (commDegree.get(currentComm) || 0) - ki);
        commDegree.set(bestComm, (commDegree.get(bestComm) || 0) + ki);
        improved = true;
      }
    }
  }

  // Renumber contiguously
  const uniqueComms = [...new Set(community.values())];
  const reindex = new Map<number, number>();
  uniqueComms.forEach((c, i) => reindex.set(c, i));
  const result = new Map<string, number>();
  for (const [nodeId, comm] of community) result.set(nodeId, reindex.get(comm)!);
  return result;
}

// ── Icy palette for communities ──────────────────────────────

const ICY_PALETTE: [number, number, number][] = [
  [0.494, 0.784, 1.0], [0.357, 0.722, 0.8], [0.416, 0.624, 0.749],
  [0.659, 0.867, 0.937], [0.45, 0.70, 0.90], [0.55, 0.80, 0.85],
  [0.40, 0.65, 0.82], [0.52, 0.76, 0.92], [0.38, 0.68, 0.78],
  [0.60, 0.85, 0.95], [0.48, 0.74, 0.88], [0.56, 0.82, 0.90],
];

// ── Transform GraphData → scene data ─────────────────────────

interface InterEdgeDef {
  src: number; dst: number; birthTime: number;
  edges: { srcIdx: number; dstIdx: number; relation: string }[];
}
interface IntraEdgeDef {
  cluster: number; birthTime: number; srcIdx: number; dstIdx: number; relation: string;
}
interface TransformedData {
  clusters: ClusterDef[];
  allNodeDefs: NodeDef[];
  interEdges: InterEdgeDef[];
  intraEdges: IntraEdgeDef[];
  groupDefs: { name: string; color: THREE.Vector3; clusterSet: Set<number>; members: NodeDef[] }[];
  nodeGroupColors: THREE.Vector3[];
  nodeGroupMembership: Record<number, number[]>;
  clusterGroupColor: Record<number, THREE.Color>;
}

const GRAPH_LAYOUT_CACHE_STORAGE_KEY = "kept.graphExplorer.layout.v1";
const GRAPH_LAYOUT_CACHE_VERSION = 1;

function yieldToMainThread() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function updateHash(hash: number, text: string): number {
  let next = hash;
  for (let i = 0; i < text.length; i++) {
    next ^= text.charCodeAt(i);
    next = Math.imul(next, 16777619);
  }
  return next >>> 0;
}

function computeGraphFingerprint(graphData: GraphData): string {
  let hash = 2166136261;
  hash = updateHash(hash, `v${GRAPH_LAYOUT_CACHE_VERSION}|n${graphData.nodes.length}|e${graphData.edges.length}|`);
  for (const node of graphData.nodes) {
    hash = updateHash(
      hash,
      [
        node.id,
        node.name,
        node.node_type,
        node.frequency ?? "",
        node.entity_type ?? "",
        node.platform ?? "",
        node.file_path ?? "",
        node.thread_count ?? "",
        node.neighbor_count ?? "",
        (node.synonyms ?? []).join(","),
      ].join("|") + ";",
    );
  }
  for (const edge of graphData.edges) {
    hash = updateHash(
      hash,
      [edge.source, edge.target, edge.relation, edge.weight].join("|") + ";",
    );
  }
  return hash.toString(16);
}

function serializeTransformedData(transformed: TransformedData): SerializedTransformedData {
  return {
    clusters: transformed.clusters.map((cluster) => ({
      center: [cluster.center.x, cluster.center.y, cluster.center.z],
      birthTime: cluster.birthTime,
      nodeCount: cluster.nodeCount,
      name: cluster.name,
    })),
    allNodeDefs: transformed.allNodeDefs.map((def) => ({
      pos: [def.pos.x, def.pos.y, def.pos.z],
      intensity: def.intensity,
      cluster: def.cluster,
      birthTime: def.birthTime,
      rotY: def.rotY,
      id: def.id,
      idx: def.idx,
      protocol: def.protocol,
      status: def.status,
      connections: def.connections,
      entityId: def.entityId,
      entityType: def.entityType,
      nodeType: def.nodeType,
      frequency: def.frequency,
      synonyms: def.synonyms,
      threadCount: def.threadCount,
      neighborCount: def.neighborCount,
      platform: def.platform,
      filePath: def.filePath,
    })),
    interEdges: transformed.interEdges,
    intraEdges: transformed.intraEdges,
  };
}

function buildDerivedTransformedData(serialized: SerializedTransformedData): TransformedData {
  const clusters: ClusterDef[] = serialized.clusters.map((cluster) => ({
    center: new THREE.Vector3(...cluster.center),
    birthTime: cluster.birthTime,
    nodeCount: cluster.nodeCount,
    nodes: [],
    name: cluster.name,
  }));

  const allNodeDefs: NodeDef[] = serialized.allNodeDefs.map((def) => ({
    pos: new THREE.Vector3(...def.pos),
    intensity: def.intensity,
    tier: 3 as const,
    cluster: def.cluster,
    birthTime: def.birthTime,
    rotY: def.rotY,
    id: def.id,
    idx: def.idx,
    protocol: def.protocol,
    status: def.status,
    connections: def.connections,
    entityId: def.entityId,
    entityType: def.entityType,
    nodeType: def.nodeType,
    frequency: def.frequency,
    synonyms: def.synonyms,
    threadCount: def.threadCount,
    neighborCount: def.neighborCount,
    platform: def.platform,
    filePath: def.filePath,
  }));
  assignTiers(allNodeDefs);

  for (const def of allNodeDefs) {
    clusters[def.cluster]?.nodes.push(def);
  }

  const groupDefs = clusters.map((cl, ci) => {
    const pal = ICY_PALETTE[ci % ICY_PALETTE.length];
    return {
      name: cl.name.toUpperCase(),
      color: new THREE.Vector3(pal[0], pal[1], pal[2]),
      clusterSet: new Set([ci]),
      members: cl.nodes,
    };
  });

  const nodeGroupColors = allNodeDefs.map((def) => {
    const pal = ICY_PALETTE[def.cluster % ICY_PALETTE.length];
    return new THREE.Vector3(pal[0], pal[1], pal[2]);
  });

  const nodeGroupMembership: Record<number, number[]> = {};
  allNodeDefs.forEach((def) => { nodeGroupMembership[def.idx] = [def.cluster]; });

  const clusterGroupColor: Record<number, THREE.Color> = {};
  for (let c = 0; c < clusters.length; c++) {
    const pal = ICY_PALETTE[c % ICY_PALETTE.length];
    clusterGroupColor[c] = new THREE.Color(pal[0], pal[1], pal[2]);
  }

  return {
    clusters,
    allNodeDefs,
    interEdges: serialized.interEdges,
    intraEdges: serialized.intraEdges,
    groupDefs,
    nodeGroupColors,
    nodeGroupMembership,
    clusterGroupColor,
  };
}

function loadCachedTransformedData(graphKey: string): TransformedData | null {
  try {
    const raw = window.localStorage.getItem(GRAPH_LAYOUT_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      version: number;
      graphKey: string;
      data: SerializedTransformedData;
    };
    if (parsed.version !== GRAPH_LAYOUT_CACHE_VERSION || parsed.graphKey !== graphKey) return null;
    return buildDerivedTransformedData(parsed.data);
  } catch {
    return null;
  }
}

function persistTransformedData(graphKey: string, transformed: TransformedData) {
  try {
    const payload = JSON.stringify({
      version: GRAPH_LAYOUT_CACHE_VERSION,
      graphKey,
      data: serializeTransformedData(transformed),
    });
    window.localStorage.setItem(GRAPH_LAYOUT_CACHE_STORAGE_KEY, payload);
  } catch {
    // Ignore quota/storage errors; cache is an optimization only.
  }
}

async function transformGraphData(graphData: GraphData, onProgress?: (text: string) => void): Promise<TransformedData> {
  const { nodes, edges } = graphData;
  onProgress?.("Detecting communities");
  const communities = louvainCommunities(nodes, edges);
  await yieldToMainThread();

  // Group nodes by community, sorted by size descending
  const commMap = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const c = communities.get(node.id) ?? 0;
    if (!commMap.has(c)) commMap.set(c, []);
    commMap.get(c)!.push(node);
  }
  const sortedComms = [...commMap.entries()].sort((a, b) => b[1].length - a[1].length);
  const commReindex = new Map<number, number>();
  sortedComms.forEach(([oldIdx], newIdx) => commReindex.set(oldIdx, newIdx));
  await yieldToMainThread();

  const CLUSTERS = sortedComms.length;
  const nodesPerCluster = nodes.length / Math.max(1, CLUSTERS);
  const SPREAD = Math.max(4, Math.min(14, Math.sqrt(nodes.length) * 0.6));
  const CLUSTER_R = Math.max(1.5, Math.sqrt(nodesPerCluster) * 0.45);

  // Seeded PRNG for deterministic layout
  let _s = 42;
  const sr = () => { _s = (_s * 16807) % 2147483647; return (_s - 1) / 2147483646; };
  const sr2 = (a: number, b: number) => a + sr() * (b - a);

  // Cluster centers — placed radially on XZ plane, Y=0
  const clusters: ClusterDef[] = sortedComms.map(([_, commNodes], ci) => {
    const angle = ci * (Math.PI * 2 / CLUSTERS) + sr2(-0.3, 0.3);
    const r = SPREAD + sr2(-0.6, 0.6);
    const sorted = [...commNodes].sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0));
    return {
      center: new THREE.Vector3(Math.cos(angle) * r, sr2(-1.5, 1.5), Math.sin(angle) * r),
      birthTime: 0.02 + (ci / Math.max(1, CLUSTERS)) * 0.3 + sr2(-0.02, 0.02),
      nodeCount: commNodes.length,
      nodes: [] as NodeDef[],
      name: sorted[0]?.name ?? `Cluster ${ci}`,
    };
  });

  // Normalize intensity from message count
  const maxMsgCount = Math.max(1, ...nodes.map(n => n.frequency ?? 1));

  const nodeIdToIdx = new Map<string, number>();
  const allNodeDefs: NodeDef[] = [];

  onProgress?.(`Laying out ${nodes.length} nodes`);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const origComm = communities.get(node.id) ?? 0;
    const ci = commReindex.get(origComm) ?? 0;
    const cl = clusters[ci];
    const isHub = node.node_type === "topic" || node.node_type === "provider";
    const msgNorm = isHub ? 1.0 : (node.frequency ?? 1) / maxMsgCount;
    const intensity = isHub ? 1.0 : 0.2 + 0.8 * Math.sqrt(msgNorm);

    const theta = sr2(0, Math.PI * 2);
    const rMin = CLUSTER_R * 0.15;
    const r = sr2(rMin, CLUSTER_R);

    // Y: nodes at the edge rise higher, central nodes sit low (bowl/crater shape)
    const edgeness = (r - rMin) / (CLUSTER_R - rMin); // 0 at center, 1 at edge
    const nodeY = cl.center.y - CLUSTER_R * 0.5 + edgeness * CLUSTER_R * 0.8 + sr2(-0.8, 0.8);

    const pos = new THREE.Vector3(
      cl.center.x + Math.cos(theta) * r,
      nodeY,
      cl.center.z + Math.sin(theta) * r,
    );
    const nodeRatio = allNodeDefs.length / Math.max(1, nodes.length);
    const bt = cl.birthTime + nodeRatio * 0.12 + sr2(0, 0.05);

    // Entity names are lowercased in the KG DB; title-case only all-lowercase names
    const displayName = node.name === node.name.toLowerCase()
      ? node.name.replace(/(^|\s)\p{L}/gu, c => c.toUpperCase())
      : node.name;

    const def: NodeDef = {
      pos, intensity, tier: 3 as const, cluster: ci,
      birthTime: Math.min(bt, 0.82),
      rotY: sr2(0, Math.PI),
      id: displayName, // display label
      idx: allNodeDefs.length,
      protocol: node.entity_type ?? node.node_type ?? '',
      status: node.node_type ?? 'entity',
      connections: [],
      entityId: node.id,
      entityType: node.entity_type,
      nodeType: node.node_type,
      frequency: node.frequency,
      synonyms: node.synonyms,
      threadCount: node.thread_count,
      neighborCount: node.neighbor_count,
      platform: node.platform,
      filePath: node.file_path,
    };
    cl.nodes.push(def);
    allNodeDefs.push(def);
    if (i % 120 === 119) {
      onProgress?.(`Laying out ${i + 1} / ${nodes.length} nodes`);
      await yieldToMainThread();
    }
  }

  // Sort by birthTime and re-index
  allNodeDefs.sort((a, b) => a.birthTime - b.birthTime);
  allNodeDefs.forEach((def, i) => { def.idx = i; nodeIdToIdx.set(def.entityId!, i); });
  assignTiers(allNodeDefs);
  await yieldToMainThread();

  // Classify edges
  const interMap = new Map<string, { src: number; dst: number; edges: { srcIdx: number; dstIdx: number; relation: string }[] }>();
  const intraEdges: IntraEdgeDef[] = [];

  onProgress?.(`Classifying ${edges.length} edges`);
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const srcIdx = nodeIdToIdx.get(edge.source);
    const dstIdx = nodeIdToIdx.get(edge.target);
    if (srcIdx === undefined || dstIdx === undefined) continue;
    const srcCluster = allNodeDefs[srcIdx].cluster;
    const dstCluster = allNodeDefs[dstIdx].cluster;

    if (srcCluster === dstCluster) {
      const cl = clusters[srcCluster];
      const latest = Math.max(...cl.nodes.map(n => n.birthTime));
      intraEdges.push({
        cluster: srcCluster,
        birthTime: Math.min(latest + sr2(0.01, 0.05), 0.88),
        srcIdx, dstIdx,
        relation: edge.relation,
      });
    } else {
      const [a, b] = srcCluster < dstCluster ? [srcCluster, dstCluster] : [dstCluster, srcCluster];
      const key = `${a}-${b}`;
      if (!interMap.has(key)) interMap.set(key, { src: a, dst: b, edges: [] });
      interMap.get(key)!.edges.push({ srcIdx, dstIdx, relation: edge.relation });
    }
    if (i % 250 === 249) {
      onProgress?.(`Classifying ${i + 1} / ${edges.length} edges`);
      await yieldToMainThread();
    }
  }

  const interEdges: InterEdgeDef[] = [];
  const bundles = [...interMap.values()];
  for (let i = 0; i < bundles.length; i++) {
    const bundle = bundles[i];
    const latest = Math.max(
      ...clusters[bundle.src].nodes.map(n => n.birthTime),
      ...clusters[bundle.dst].nodes.map(n => n.birthTime),
    );
    interEdges.push({
      src: bundle.src, dst: bundle.dst,
      birthTime: Math.min(latest + sr2(0.03, 0.1), 0.92),
      edges: bundle.edges,
    });
    if (i % 40 === 39) {
      await yieldToMainThread();
    }
  }

  // Groups: 1 per community
  const groupDefs = clusters.map((cl, ci) => {
    const pal = ICY_PALETTE[ci % ICY_PALETTE.length];
    return {
      name: cl.name.toUpperCase(),
      color: new THREE.Vector3(pal[0], pal[1], pal[2]),
      clusterSet: new Set([ci]),
      members: cl.nodes,
    };
  });

  // Per-node group color
  const nodeGroupColors = allNodeDefs.map(def => {
    const pal = ICY_PALETTE[def.cluster % ICY_PALETTE.length];
    return new THREE.Vector3(pal[0], pal[1], pal[2]);
  });

  // Node group membership
  const nodeGroupMembership: Record<number, number[]> = {};
  allNodeDefs.forEach(def => { nodeGroupMembership[def.idx] = [def.cluster]; });

  // Cluster colors
  const clusterGroupColor: Record<number, THREE.Color> = {};
  for (let c = 0; c < CLUSTERS; c++) {
    const pal = ICY_PALETTE[c % ICY_PALETTE.length];
    clusterGroupColor[c] = new THREE.Color(pal[0], pal[1], pal[2]);
  }

  return { clusters, allNodeDefs, interEdges, intraEdges, groupDefs, nodeGroupColors, nodeGroupMembership, clusterGroupColor };
}

function transformGraphDataInWorker(
  graphData: GraphData,
  registerWorker?: (worker: Worker | null) => void,
): Promise<TransformedData> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./graph-layout-worker.ts", import.meta.url), { type: "module" });
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      registerWorker?.(null);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    worker.onmessage = (evt: MessageEvent<GraphLayoutWorkerResponse>) => {
      const { data, error } = evt.data;
      cleanup();
      if (error) {
        reject(new Error(error));
        return;
      }
      if (!data) {
        reject(new Error("Graph layout worker returned no data"));
        return;
      }
      resolve(buildDerivedTransformedData(data));
    };

    worker.onerror = (evt) => {
      cleanup();
      reject(new Error(evt.message || "Graph layout worker failed"));
    };

    registerWorker?.(worker);
    const payload: GraphLayoutWorkerRequest = { graphData };
    worker.postMessage(payload);
  });
}

// ── Component ────────────────────────────────────────────────

export default function GraphExplorer({
  visible = true,
  onReady,
  onStatusChange,
  searchQuery = "",
  searchZoomTrigger = 0,
  prefetchedData,
  hasApiKey = false,
  onNavigateSettings,
  onOpenConversation,
}: {
  visible?: boolean;
  onReady?: () => void;
  onStatusChange?: (status: string) => void;
  searchQuery?: string;
  searchZoomTrigger?: number;
  prefetchedData?: Promise<GraphData>;
  hasApiKey?: boolean;
  onNavigateSettings?: () => void;
  onOpenConversation?: (filePath: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    animId: number;
    clock: THREE.Clock;
    disposed: boolean;
    // Orbit state
    rY: number; rX: number; dZ: number;
    panOffset: THREE.Vector3;
    isDrag: boolean; isPan: boolean;
    pm: { x: number; y: number };
    dragDist: number;
    zoomAnimating: boolean; zoomProgress: number;
    zoomFrom: { rY: number; rX: number; dZ: number; pan: THREE.Vector3 } | null;
    zoomTo: { rY: number; rX: number; dZ: number; pan: THREE.Vector3 } | null;
    // Data
    allNodeDefs: NodeDef[];
    clusters: ClusterDef[];
    nodeMeshes: THREE.Mesh[];
    dotMeshes: THREE.Mesh[];
    allLines: THREE.Line[];
    contourMeshes: { main: THREE.LineBasicMaterial; fence: THREE.LineBasicMaterial; ground: THREE.LineBasicMaterial; wall: THREE.MeshPhongMaterial; cap: THREE.MeshPhongMaterial; targetOp: number; currentOp: number; currentDim?: number }[];
    envelopes: null[];
    nodeGroupMembership: Record<number, number[]>;
    activeGroupSet: Set<number>;
    groupDefs: { name: string; color: THREE.Vector3; clusterSet: Set<number>; members: NodeDef[] }[];
    // Hover/select
    hoveredNode: THREE.Mesh | null;
    clickTarget: THREE.Mesh | null;
    selectedDef: NodeDef | null;
    connectedSet: Set<number> | null;
    selectionLabelSet: Set<number> | null;
    hoverConnectedSet: Set<number> | null;
    hoverLabelSet: Set<number> | null;
    hoverStartTime: number;
    adjacency: Map<number, number[]>;
    focusedGroupSet: Set<number> | null;
    mouse: THREE.Vector2;
    // Timeline
    currentT: number;
    playing: boolean;
    // Loop
    animate: () => void;
    pendingAspect: number | null;
    resizeTimer: number;
  } | null>(null);

  // UI state
  const [selectedNode, setSelectedNode] = useState<SelectedNodeInfo | null>(null);
  const [activeGroups] = useState<Set<number>>(new Set());
  const [playing, setPlaying] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [graphEmpty, setGraphEmpty] = useState(false);
  const [hasConversations, setHasConversations] = useState<boolean | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  // Re-check conversation count when navigating to Explorer with an empty graph
  useEffect(() => {
    if (!visible || !graphEmpty) return;
    listConversations().then(convs => setHasConversations(convs.length > 0)).catch(() => {});
  }, [visible, graphEmpty]);
  const initProgressRef = useRef<HTMLDivElement>(null);
  const setInitProgress = useCallback((text: string) => {
    if (initProgressRef.current) initProgressRef.current.textContent = text;
    onStatusChange?.(text);
  }, [onStatusChange]);
  const [reinitTrigger, setReinitTrigger] = useState(0);
  const [, setCommunities] = useState<{ name: string; color: string }[]>([]);

  // Raw markdown of the first user message in the selected conversation,
  // rendered in the side panel via `<MarkdownRenderer>`. Clamped visually
  // (max-height + bottom fade) so long messages don't blow out the panel.
  const [nodePreview, setNodePreview] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedNode || selectedNode.nodeType !== "conversation" || !selectedNode.filePath) {
      setNodePreview(null);
      return;
    }
    let cancelled = false;
    getConversation(selectedNode.filePath).then((md) => {
      if (cancelled) return;
      const { body } = parseFrontmatter(md);
      const { messages } = parseMessages(body);
      const firstUser = messages.find((m) => m.role === "user");
      setNodePreview(firstUser?.content?.trim() || null);
    }).catch(() => { if (!cancelled) setNodePreview(null); });
    return () => { cancelled = true; };
  }, [selectedNode]);

  const agentHighlightIndicesRef = useRef<Set<number>>(new Set());
  const agentHighlightUntilRef = useRef(0);

  // Search: compute matched node indices
  const searchHitsRef = useRef<Set<number>>(new Set());
  const searchActiveRef = useRef(false);
  useEffect(() => {
    const s = stateRef.current;
    if (!s || !s.allNodeDefs.length) { searchHitsRef.current = new Set(); searchActiveRef.current = false; return; }
    const q = searchQuery.trim().toLowerCase();
    if (!q) { searchHitsRef.current = new Set(); searchActiveRef.current = false; return; }
    searchActiveRef.current = true;
    const terms = q.split(/\s+/);
    const hits = new Set<number>();
    for (const def of s.allNodeDefs) {
      const text = `${def.id} ${def.protocol} ${def.status} ${(def.synonyms || []).join(' ')} ${def.entityType || ''} ${def.nodeType || ''}`.toLowerCase();
      if (terms.every(t => text.includes(t))) hits.add(def.idx);
    }
    // Also match group names
    for (const g of s.groupDefs) {
      if (terms.every(t => g.name.toLowerCase().includes(t))) {
        for (const m of g.members) hits.add(m.idx);
      }
    }
    searchHitsRef.current = hits;
  }, [searchQuery]);

  // Zoom to bounding box of search hits on submit
  useEffect(() => {
    if (searchZoomTrigger === 0) return;
    const s = stateRef.current;
    const hits = searchHitsRef.current;
    if (!s || hits.size === 0) return;

    // Compute bounding box of hit nodes
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const idx of hits) {
      const def = s.allNodeDefs[idx];
      if (!def) continue;
      min.min(def.pos);
      max.max(def.pos);
    }
    const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(max, min);
    const extent = Math.max(size.x, size.y, size.z, 2); // minimum extent to avoid ultra-close zoom

    // Camera: center on bounding box, elevated angle
    const tRY = Math.atan2(center.x, center.z);
    const tRX = 0.35; // slightly elevated for upper view
    const tDZ = Math.max(6, extent * 1.4 + 4); // distance based on extent + padding

    const panTo = center.clone();

    s.zoomFrom = { rY: s.rY, rX: s.rX, dZ: s.dZ, pan: s.panOffset.clone() };
    s.zoomTo = { rY: tRY, rX: tRX, dZ: tDZ, pan: panTo };
    // Shortest rotation path
    while (s.zoomTo.rY - s.zoomFrom.rY > Math.PI) s.zoomTo.rY -= Math.PI * 2;
    while (s.zoomTo.rY - s.zoomFrom.rY < -Math.PI) s.zoomTo.rY += Math.PI * 2;
    s.zoomAnimating = true;
    s.zoomProgress = 0;
  }, [searchZoomTrigger]);

  // Refs for current UI state (avoid stale closures)
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const activeGroupsRef = useRef(activeGroups);
  activeGroupsRef.current = activeGroups;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const ICY = 0xC3ECFF;
  const BG = 0x020A0D; // matches --color-base

  // ── Init Three.js scene ──

  const initScene = useCallback((transformed: TransformedData) => {
    const container = containerRef.current;
    const canvas = canvasRef.current!;
    if (!container || !canvas) return;

    const w = container.clientWidth;
    const h = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(BG, 0.04);

    const camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 200);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(BG);

    scene.add(new THREE.AmbientLight(ICY, 0.4));
    const dirL = new THREE.DirectionalLight(0xBAE8FF, 0.4);
    dirL.position.set(5, 12, 8);
    scene.add(dirL);
    const ptL1 = new THREE.PointLight(0xA6E1FF, 0.25, 35);
    ptL1.position.set(-4, 6, -3);
    scene.add(ptL1);
    const ptL2 = new THREE.PointLight(0xd4f0ff, 0.15, 25);
    ptL2.position.set(3, -2, 5);
    scene.add(ptL2);

    // Helpers
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const lerp3 = (a: THREE.Vector3, b: THREE.Vector3, t: number) => new THREE.Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

    const { clusters, allNodeDefs, interEdges, intraEdges, nodeGroupMembership, clusterGroupColor } = transformed;

    // Three objects
    const nodeGroup = new THREE.Group();
    scene.add(nodeGroup);
    const edgeGroup = new THREE.Group();
    scene.add(edgeGroup);
    const contourGroup = new THREE.Group();
    scene.add(contourGroup);

    const nodeShapeCache: Record<string, THREE.BufferGeometry> = {};
    function getNodeGeometry(shape: string, size: number) {
      const key = `${shape}:${size.toFixed(3)}`;
      if (!nodeShapeCache[key]) {
        nodeShapeCache[key] = createNodeShapeGeometry(shape as Parameters<typeof createNodeShapeGeometry>[0], size);
      }
      return nodeShapeCache[key];
    }

    const textPlaneGeo = new THREE.PlaneGeometry(2.0, 0.3125);

    const nodeMeshes: THREE.Mesh[] = [];
    const dotMeshes: THREE.Mesh[] = [];

    // Edges
    function mkBundleLine(srcPos: THREE.Vector3, dstPos: THREE.Vector3, srcC: THREE.Vector3, dstC: THREE.Vector3, mid: THREE.Vector3, _intensity: number, edgeColor: THREE.Color) {
      // Smooth arc: source → guide near source cluster center → midpoint → guide near dest cluster center → dest.
      // Use centripetal Catmull-Rom — uniform ("catmullrom") with a high
      // tension overshoots at the endpoints when the control polygon is
      // nearly straight, which visibly kinks the first/last segment
      // backwards before heading toward the neighbour.
      const c1 = lerp3(srcPos, srcC, 0.4);
      const c2 = lerp3(dstPos, dstC, 0.4);
      const curve = new THREE.CatmullRomCurve3([srcPos.clone(), c1, mid.clone(), c2, dstPos.clone()], false, "centripetal");
      const pts = curve.getPoints(32);
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color: edgeColor || ICY, transparent: true, opacity: 0, depthWrite: false });
      const line = new THREE.Line(geo, mat);
      line.userData = { totalPts: 33 };
      line.geometry.setDrawRange(0, 0);
      edgeGroup.add(line);
      return line;
    }

    const allLines: THREE.Line[] = [];

    // Groups from transformed data
    const { groupDefs } = transformed;

    const contourMeshes: typeof stateRef.current extends null ? never : NonNullable<typeof stateRef.current>["contourMeshes"] = [];

    const state: NonNullable<typeof stateRef.current> = {
      renderer, scene, camera, animId: 0, clock: new THREE.Clock(), disposed: false,
      rY: 0, rX: 0.35, dZ: 24, panOffset: new THREE.Vector3(),
      isDrag: false, isPan: false, pm: { x: 0, y: 0 }, dragDist: 0,
      zoomAnimating: false, zoomProgress: 0, zoomFrom: null, zoomTo: null,
      allNodeDefs, clusters, nodeMeshes, dotMeshes, allLines, contourMeshes,
      envelopes: groupDefs.map(() => null),
      nodeGroupMembership, activeGroupSet: new Set(),
      groupDefs,
      hoveredNode: null, clickTarget: null, selectedDef: null,
      connectedSet: null, selectionLabelSet: null, hoverConnectedSet: null, hoverLabelSet: null, hoverStartTime: 0, adjacency: new Map(), focusedGroupSet: null,
      mouse: new THREE.Vector2(),
      currentT: 0, playing: false,
      animate: () => { }, // set below
      pendingAspect: null,
      resizeTimer: 0,
    };
    stateRef.current = state;

    // ── Animate ──
    const ease = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const sms = (lo: number, hi: number, t: number) => { const x = Math.max(0, Math.min(1, (t - lo) / (hi - lo))); return x * x * (3 - 2 * x); };
    const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

    // Pre-allocated temporaries — reused every frame to avoid GC pressure

    function animate() {
      if (state.disposed) return;
      if (!visibleRef.current) {
        // Paused — don't schedule next frame; useEffect will resume
        state.clock.getDelta(); // drain accumulated delta so we don't get a huge jump on resume
        state.animId = 0;
        return;
      }
      state.animId = requestAnimationFrame(animate);

      // Apply deferred aspect ratio update (cheap — no GPU reallocation)
      if (state.pendingAspect !== null) {
        state.camera.aspect = state.pendingAspect;
        state.camera.updateProjectionMatrix();
        state.pendingAspect = null;
      }

      const dt = state.clock.getDelta();
      const elapsed = state.clock.getElapsedTime();

      // Sync group set from React
      state.activeGroupSet = activeGroupsRef.current;
      state.playing = playingRef.current;

      if (state.playing) {
        state.currentT = Math.min(1, state.currentT + dt * 0.08);
        if (state.currentT >= 1) {
          state.playing = false;
          setPlaying(false);
        }
      }

      // Zoom animation
      if (state.zoomAnimating && state.zoomFrom && state.zoomTo) {
        state.zoomProgress = Math.min(1, state.zoomProgress + dt * 1.6);
        const t = ease(state.zoomProgress);
        state.rY = lerpN(state.zoomFrom.rY, state.zoomTo.rY, t);
        state.rX = lerpN(state.zoomFrom.rX, state.zoomTo.rX, t);
        state.dZ = lerpN(state.zoomFrom.dZ, state.zoomTo.dZ, t);
        state.panOffset.lerpVectors(state.zoomFrom.pan, state.zoomTo.pan, t);
        if (state.zoomProgress >= 1) state.zoomAnimating = false;
      }

      // Temporal update
      const FD = 0.06;
      const hasActiveGroups = state.activeGroupSet.size > 0;
      const selIdx = state.selectedDef ? state.selectedDef.idx : -1;
      const connectedSet = state.connectedSet;
      const nowMs = performance.now();
      if (agentHighlightUntilRef.current <= nowMs && agentHighlightIndicesRef.current.size > 0) {
        agentHighlightIndicesRef.current = new Set();
      }
      const agentHighlightSet = agentHighlightUntilRef.current > nowMs
        ? agentHighlightIndicesRef.current
        : new Set<number>();

      const EDGE_ACCENT = new THREE.Color(0xF05060);
      const hoverConnectedSet = state.hoverConnectedSet;
      const hoverLabelSet = state.hoverLabelSet;
      const HOVER_DIM_DELAY = 400; // ms before non-neighbors start dimming
      // Target: 1 when hover is active and past delay, 0 otherwise
      const hoverDimTarget = (hoverConnectedSet !== null &&
        (performance.now() - state.hoverStartTime) > HOVER_DIM_DELAY) ? 1 : 0;
      // Smooth interpolation: fast fade-in (0.12), slower fade-out (0.06)
      const prev = (state as any)._hoverDimSmooth ?? 0;
      const lerpRate = hoverDimTarget > prev ? 0.12 : 0.06;
      const hoverDimStrength = prev + (hoverDimTarget - prev) * lerpRate;
      (state as any)._hoverDimSmooth = Math.abs(hoverDimStrength - hoverDimTarget) < 0.003 ? hoverDimTarget : hoverDimStrength;
      const hoverDimActive = hoverDimStrength > 0.01;

      for (let i = 0; i < state.nodeMeshes.length; i++) {
        const mesh = state.nodeMeshes[i], def = state.allNodeDefs[i];
        const dot = mesh.userData.dot as THREE.Mesh;
        const p = sms(def.birthTime, def.birthTime + FD, state.currentT);
        const isHoveredNode = state.hoveredNode?.userData.def === def;
        const isSelected = def === state.selectedDef;
        const isPanelHighlight = (state as any)._panelHighlightIdx === def.idx;

        // Dot scaling with smooth hover transition
        if (dot) {
          const cTier = (def as any).centralityTier || 1.0;
          const hoverDotTarget = isHoveredNode || isPanelHighlight ? 2.2 : 1.0;
          const prevDotHover = dot.userData.hoverScale ?? 1.0;
          const curDotHover = prevDotHover + (hoverDotTarget - prevDotHover) * 0.18;
          dot.userData.hoverScale = Math.abs(curDotHover - hoverDotTarget) < 0.005 ? hoverDotTarget : curDotHover;
          const dotScale = ease(p) * (0.07 + def.intensity * 0.05) * 5 * cTier * dot.userData.hoverScale;
          dot.scale.set(dotScale, dotScale, dotScale);
        }

        // Label scale
        const sc = ease(p);
        const baseScale = mesh.userData.baseScale || 0.5;
        const zoomScale = Math.max(0.6, Math.min(1.0, 16.0 / state.dZ));
        const nodeDist = mesh.position.distanceTo(camera.position);
        const distRatio = nodeDist / Math.max(state.dZ, 5);
        const distShrink = 1.0 / (1.0 + Math.max(0, distRatio - 0.6) * 0.8);

        // Tier-based target opacities
        const baseDotOp = tierDotOpacity(def.tier, state.dZ);
        const baseLabelOp = tierLabelOpacity(def.tier, state.dZ);

        // dimFactor chain
        const isActive = isSelected || (connectedSet && connectedSet.has(def.idx));
        const inActiveGroup = hasActiveGroups && (state.nodeGroupMembership[def.idx] || []).some(gi => state.activeGroupSet.has(gi));
        const isConnectedNeighbor = !isSelected && connectedSet !== null && connectedSet.has(def.idx);
        const isSearchHit = searchActiveRef.current && searchHitsRef.current.has(def.idx);
        const isAgentHighlight = agentHighlightSet.has(def.idx);
        const isHoverNeighbor = hoverConnectedSet !== null && hoverConnectedSet.has(def.idx);

        let dimFactor = 1.0;

        // Selection dimming (always applied as base layer)
        if (connectedSet) {
          if (connectedSet.has(def.idx)) dimFactor = 1.0;
          else dimFactor *= 0.15;
        }
        // Hover neighborhood (layered on top of selection)
        if (hoverConnectedSet) {
          if (isHoveredNode || isHoverNeighbor) {
            dimFactor = 1.0;
          } else if (hoverDimActive) {
            // Smoothly dim non-neighbors, but never brighter than current dimFactor
            const hoverDim = 1.0 - hoverDimStrength * 0.82;
            dimFactor = Math.min(dimFactor, hoverDim);
          }
        }
        // Hovered node always punches through
        if (isHoveredNode) dimFactor = Math.max(dimFactor, 0.8);
        // Agent highlight
        if (isAgentHighlight) dimFactor = Math.max(dimFactor, 0.95);
        // Group filtering
        if (hasActiveGroups && !inActiveGroup) {
          dimFactor *= 0.12;
        }
        // Search dimming
        const isSearchDimmed = searchActiveRef.current && !isSearchHit && !isActive;
        if (isSearchDimmed) dimFactor *= 0.15;
        if (isSearchHit) dimFactor = Math.max(dimFactor, 0.9);

        // Label sub-dimming for connected neighbors
        const labelDimFactor = isConnectedNeighbor ? dimFactor * 0.55 : dimFactor;

        // Force-visibility overrides (search/agent/hover punch through tier gating)
        // Hover neighbors: dots always boosted, but labels only for Tier 1/2
        // (prevents label explosion on highly-connected hub nodes)
        const hoverForcesLabel = hoverLabelSet !== null && hoverLabelSet.has(def.idx);
        const isHoverLabelNeighbor = hoverForcesLabel && !isHoveredNode;
        const selectionForcesLabel = state.selectionLabelSet !== null && state.selectionLabelSet.has(def.idx);
        const forceVisible = hoverForcesLabel || selectionForcesLabel || isSelected || isSearchHit || isAgentHighlight;
        const forceDotVisible = forceVisible || isHoverNeighbor;
        const finalDotOp = forceDotVisible ? Math.max(baseDotOp, 0.8) : baseDotOp;
        // Hover neighbor labels fade in with the dimming (subtle → full), never below base
        const hoverBoostTarget = Math.max(baseLabelOp, 0.7);
        const hoverLabelTarget = isHoverLabelNeighbor
          ? baseLabelOp + (hoverBoostTarget - baseLabelOp) * hoverDimStrength
          : forceVisible ? hoverBoostTarget : baseLabelOp;
        const finalLabelOp = hoverLabelTarget;

        // Label scale
        const labelVis = finalLabelOp * labelDimFactor * p;
        let targetScale: number;
        if (labelVis < 0.05) {
          targetScale = 0;
        } else {
          const hoverLabelTarget = isHoveredNode ? 1.5 : 1.0;
          const prevLabelHover = mesh.userData.hoverLabelScale ?? 1.0;
          const curLabelHover = prevLabelHover + (hoverLabelTarget - prevLabelHover) * 0.18;
          mesh.userData.hoverLabelScale = Math.abs(curLabelHover - hoverLabelTarget) < 0.005 ? hoverLabelTarget : curLabelHover;
          targetScale = sc * baseScale * zoomScale * distShrink * Math.min(1, labelVis * 2) * mesh.userData.hoverLabelScale;
          // Clamp all visible labels to minimum readable screen size
          // screenPx = meshHeight * scale * viewportH / (2 * dist * tan(fov/2))
          // meshHeight = 0.3125 (from PlaneGeometry), fov=38° → 2*tan(19°)=0.6886
          const screenPxPerScale = 0.3125 * canvas.clientHeight / (0.6886 * nodeDist);
          targetScale = Math.max(targetScale, 18 / screenPxPerScale);
        }
        mesh.scale.set(targetScale, targetScale, targetScale);

        // Render order — hovered/selected/panel-highlighted labels always on top
        mesh.renderOrder = isPanelHighlight ? 10001 : isHoveredNode ? 10000 : isSelected ? 9999 : (connectedSet && connectedSet.has(def.idx)) ? 9000 : 1000 - Math.floor(nodeDist * 10);

        // Highlight value (selection crimson-rose + search + hover neighborhood + panel highlight)
        const hlTarget = isPanelHighlight ? 0.95 : isSelected ? 1.0 : isHoveredNode ? 0.9 : isSearchHit ? 0.7 : isAgentHighlight ? 0.85 : isHoverNeighbor ? 0.55 : (connectedSet && connectedSet.has(def.idx)) ? 0.55 : 0;
        mesh.userData.hlVal = (mesh.userData.hlVal || 0) + (hlTarget - (mesh.userData.hlVal || 0)) * 0.25;
        const hl = mesh.userData.hlVal;

        // Label opacity — hovered/selected/panel-highlighted always full and on top
        const isFocused = isHoveredNode || isSelected || isPanelHighlight;
        const labelOpacity = isFocused ? 1.0 : finalLabelOp * labelDimFactor * p;
        (mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value = labelOpacity;
        (mesh.material as THREE.ShaderMaterial).depthWrite = isFocused || dimFactor > 0.5;
        (mesh.material as THREE.ShaderMaterial).depthTest = !isFocused;
        (mesh.material as THREE.ShaderMaterial).uniforms.uHover.value = 0;
        (mesh.material as THREE.ShaderMaterial).uniforms.uHighlight.value = hl;

        // Dot opacity
        if (dot) {
          dot.position.copy(mesh.position);
          dot.renderOrder = isPanelHighlight ? 10001 : isHoveredNode ? 10000 : isSelected ? 9999 : 1000 - Math.floor(nodeDist * 10) - 1;
          const dotOpacity = isFocused ? 1.0 : finalDotOp * dimFactor * p * (isHoveredNode ? 1.8 : 1.0);
          (dot.material as THREE.ShaderMaterial).uniforms.uOpacity.value = dotOpacity;
          (dot.material as THREE.ShaderMaterial).depthWrite = false;
          (dot.material as THREE.ShaderMaterial).depthTest = !isFocused;
          (dot.material as THREE.ShaderMaterial).uniforms.uTime.value = elapsed;
          (dot.material as THREE.ShaderMaterial).uniforms.uHover.value = isHoveredNode ? 1.0 : 0;
          (dot.material as THREE.ShaderMaterial).uniforms.uHighlight.value = hl;
        }
      }

      // Build per-node dot opacity lookup for edge visibility
      const nodeDotOpacities = new Float32Array(state.allNodeDefs.length);
      for (let i = 0; i < state.dotMeshes.length; i++) {
        const dot = state.dotMeshes[i];
        nodeDotOpacities[i] = dot ? (dot.material as THREE.ShaderMaterial).uniforms.uOpacity.value : 0;
      }

      for (let i = 0; i < state.allLines.length; i++) {
        const line = state.allLines[i], bt = line.userData.birthTime;
        const p = sms(bt, bt + 0.06, state.currentT);
        line.geometry.setDrawRange(0, Math.floor(p * line.userData.totalPts));

        const srcIdx = line.userData.srcIdx;
        const dstIdx = line.userData.dstIdx;
        const srcDotOp = nodeDotOpacities[srcIdx] ?? 0;
        const dstDotOp = nodeDotOpacities[dstIdx] ?? 0;

        // Edge visible only if both endpoints are visible
        const bothVisible = srcDotOp > 0.1 && dstDotOp > 0.1;
        let op = bothVisible ? Math.min(srcDotOp, dstDotOp) * 0.4 * Math.min(1, p * 1.5) : 0;

        // Tier-based edge declutter: fade edges involving low-tier nodes
        const srcTier = state.allNodeDefs[srcIdx]?.tier ?? 3;
        const dstTier = state.allNodeDefs[dstIdx]?.tier ?? 3;
        const worstTier = Math.max(srcTier, dstTier);
        if (worstTier >= 3) op *= 0.15;

        // Hover-incident edge highlighting
        const hoveredDef = state.hoveredNode?.userData.def as NodeDef | undefined;
        const isHoverEdge = hoverConnectedSet !== null && hoveredDef &&
          (srcIdx === hoveredDef.idx || dstIdx === hoveredDef.idx);

        // Selection edge highlighting
        const isEdgeActive = selIdx >= 0 && (srcIdx === selIdx || dstIdx === selIdx);
        const isAgentHighlightedEdge = agentHighlightSet.has(srcIdx) && agentHighlightSet.has(dstIdx);

        // Group filtering
        if (hasActiveGroups) {
          const srcGroups = state.nodeGroupMembership[srcIdx] || [];
          const dstGroups = state.nodeGroupMembership[dstIdx] || [];
          const edgeInGroup = srcGroups.some(gi => state.activeGroupSet.has(gi)) && dstGroups.some(gi => state.activeGroupSet.has(gi));
          if (!edgeInGroup) op *= 0.12;
        }

        // Selection override
        if (selIdx >= 0) {
          if (isEdgeActive) {
            op = Math.max(op, 0.3);
            op = Math.min(0.65, op * 3);
          } else { op *= 0.15; }
        }

        // Hover edge override
        if (isHoverEdge) {
          op = Math.max(op, 0.5);
        }

        // Agent highlight
        if (isAgentHighlightedEdge) {
          op = Math.max(op, 0.4);
        }

        // Search dimming
        if (searchActiveRef.current && !isEdgeActive) {
          const srcHit = searchHitsRef.current.has(srcIdx);
          const dstHit = searchHitsRef.current.has(dstIdx);
          const srcInSel = connectedSet && connectedSet.has(srcIdx);
          const dstInSel = connectedSet && connectedSet.has(dstIdx);
          if (!(srcHit && dstHit) && !(srcInSel && dstInSel)) op *= 0.15;
        }

        const lineMat = line.material as THREE.LineBasicMaterial;
        lineMat.opacity = op;

        // Edge highlight color tinting
        const edgeHl = (isEdgeActive || isHoverEdge) ? 1.0 : 0.0;
        const prevHl = line.userData.hlVal || 0;
        const curHl = prevHl + (edgeHl - prevHl) * 0.14;
        line.userData.hlVal = curHl;
        if (curHl > 0.01) {
          if (!line.userData.baseColor) line.userData.baseColor = lineMat.color.getHex();
          lineMat.color.set(line.userData.baseColor).lerp(EDGE_ACCENT, curHl * 0.75);
        } else if (line.userData.baseColor) {
          lineMat.color.setHex(line.userData.baseColor);
        }
      }

      // Camera orbit — slow down on hover, gentle ramp back
      const zoomFactor = Math.min(1, 12 / Math.max(state.dZ, 1));
      const hoverTarget = state.hoveredNode ? 0.05 : 1.0;
      const prevSpeed = (state as any)._orbitSpeed ?? 1.0;
      const rate = hoverTarget < prevSpeed ? 0.1 : 0.02;
      (state as any)._orbitSpeed = prevSpeed + (hoverTarget - prevSpeed) * rate;
      if (!state.zoomAnimating) state.rY += 0.0004 * (state as any)._orbitSpeed * zoomFactor;
      camera.position.x = state.panOffset.x + Math.sin(state.rY) * Math.cos(state.rX) * state.dZ;
      camera.position.y = state.panOffset.y + Math.sin(state.rX) * state.dZ * 0.5 + 3;
      camera.position.z = state.panOffset.z + Math.cos(state.rY) * Math.cos(state.rX) * state.dZ;
      camera.lookAt(state.panOffset.x, state.panOffset.y, state.panOffset.z);

      // Billboard + bob
      for (let i = 0; i < state.nodeMeshes.length; i++) {
        const m = state.nodeMeshes[i], d = state.allNodeDefs[i];
        const cTier = (d as any).centralityTier || 1.0;
        const bobY = d.pos.y + Math.sin(elapsed * 0.5 + i * 0.7) * 0.04 * d.intensity;
        m.position.y = bobY + 0.15 + 0.25 * cTier;
        m.quaternion.copy(camera.quaternion);
        const dot = m.userData.dot as THREE.Mesh;
        if (dot) {
          dot.position.y = bobY;
          dot.rotation.x = dot.userData.baseRotX || 0;
          dot.rotation.y = d.rotY + elapsed * 0.15 * d.intensity;
          dot.rotation.z = dot.userData.baseRotZ || 0;
        }
      }

      // ── Label visibility: viewport culling only (tier system handles declutter) ──
      {
        const N = state.nodeMeshes.length;
        const margin = 60;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const _pv = new THREE.Vector3();
        for (let i = 0; i < N; i++) {
          const mesh = state.nodeMeshes[i];
          _pv.copy(mesh.position).project(camera);
          const sx = (_pv.x * 0.5 + 0.5) * w;
          const sy = (1 - (_pv.y * 0.5 + 0.5)) * h;
          const inView = sx >= -margin && sx <= w + margin && sy >= -margin && sy <= h + margin && _pv.z > 0 && _pv.z < 1;
          mesh.visible = inView;
          const dot = mesh.userData.dot as THREE.Mesh;
          if (dot) dot.visible = inView;
        }
      }

      // Hover — screen-space proximity against dot (cube) positions only; no label hits.
      // Clear hover during drag so dragging doesn't change selection target.
      let hitDot: THREE.Mesh | null = null;
      if (!state.isDrag && !state.isPan) {
        const ndcTol = Math.min(0.15, 0.025 + state.dZ * 0.004);
        let closestNdcDist = Infinity;
        const _pv = new THREE.Vector3();
        for (let i = 0; i < state.dotMeshes.length; i++) {
          const dot = state.dotMeshes[i];
          if (dot.scale.x < 0.01) continue;
          _pv.copy(dot.position).project(camera);
          if (_pv.z < 0 || _pv.z > 1) continue;
          const ddx = _pv.x - state.mouse.x;
          const ddy = _pv.y - state.mouse.y;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dist < ndcTol && dist < closestNdcDist) {
            closestNdcDist = dist;
            hitDot = dot;
          }
        }
      }
      if (hitDot !== state.hoveredNode) {
        state.hoveredNode = hitDot;
        canvas.style.cursor = hitDot ? "pointer" : (state.isDrag || state.isPan ? canvas.style.cursor : "grab");
        // Build hover neighborhood set
        if (hitDot) {
          const hDef = hitDot.userData.def as NodeDef;
          const neighbors = state.adjacency.get(hDef.idx) || [];
          state.hoverConnectedSet = new Set([hDef.idx, ...neighbors]);
          // Cap hover labels: hovered node + closest N neighbors
          const MAX_HOVER_LABELS = 8;
          const hPos = hDef.pos;
          const neighborDefs = neighbors
            .map(idx => state.allNodeDefs[idx])
            .filter(d => d != null)
            .sort((a, b) => a.pos.distanceToSquared(hPos) - b.pos.distanceToSquared(hPos))
            .slice(0, MAX_HOVER_LABELS);
          state.hoverLabelSet = new Set([hDef.idx, ...neighborDefs.map(d => d.idx)]);
          state.hoverStartTime = performance.now();
        } else {
          state.hoverConnectedSet = null;
          state.hoverLabelSet = null;
          state.hoverStartTime = 0;
        }
      }

      // Contours (use cached focusedGroupSet from selection)
      const focusedGroupSet = state.focusedGroupSet;

      state.contourMeshes.forEach((cm, ci) => {
        if (!cm) return;
        cm.currentOp += (cm.targetOp - cm.currentOp) * 0.08;
        let dimMul = 1.0;
        if (focusedGroupSet && state.activeGroupSet.size > 0 && state.activeGroupSet.has(ci)) {
          dimMul = focusedGroupSet.has(ci) ? 1.0 : 0.15;
        }
        // Dim contours of groups not containing the selected node or its neighbors
        if (selIdx >= 0 && focusedGroupSet) {
          dimMul = focusedGroupSet.has(ci) ? 1.0 : 0.18;
        }
        cm.currentDim = (cm.currentDim !== undefined ? cm.currentDim : dimMul) + (dimMul - (cm.currentDim ?? dimMul)) * 0.12;
        const op = cm.currentOp * cm.currentDim;
        cm.main.opacity = op * 0.7;
        cm.fence.opacity = op * 0.08;
        cm.ground.opacity = op * 0.25;
        cm.wall.opacity = op * 0.035;
        cm.cap.opacity = op * 0.045;
      });

      renderer.render(scene, camera);
    }

    state.animate = animate;
    // Don't start the animation loop yet — wait until async building finishes
    // so render calls don't starve the compositor (spinner animation)
    return {
      state, buildData: {
        interEdges, intraEdges,
        clusterGroupColor, nodeGroup, edgeGroup, contourGroup,
        textPlaneGeo, rand, lerp3, mkBundleLine, getNodeGeometry,
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mount / unmount ──

  const hasInitRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Warm the scene in the background so first open is cheap.
    if (hasInitRef.current) return;

    let cancelled = false;
    let layoutWorker: Worker | null = null;
    // After re-index, fetch fresh data instead of using stale prefetch
    const dataPromise = reinitTrigger > 0 ? cmdKgGetGraph(0) : (prefetchedData || cmdKgGetGraph(0));

    setInitProgress("Fetching graph data");
    dataPromise.then((graphData) => {
      if (cancelled) return;
      hasInitRef.current = true;
      if (!graphData.nodes.length) {
        setInitProgress("No knowledge graph data");
        setGraphEmpty(true);
        setSceneReady(true);
        onReady?.();
        // Check if vault has conversations to show the right empty state
        listConversations().then(convs => {
          if (!cancelled) setHasConversations(convs.length > 0);
        }).catch(() => {
          if (!cancelled) setHasConversations(false);
        });
        return;
      }
      const graphKey = computeGraphFingerprint(graphData);
      const cached = loadCachedTransformedData(graphKey);
      if (cached) {
        setInitProgress(`Loading cached layout · ${graphData.nodes.length} entities`);
        requestAnimationFrame(() => {
          if (cancelled) return;
          const result = initScene(cached);
          if (!result) return;
          setupScene(result);
        });
        return;
      }

      setInitProgress(`Processing ${graphData.nodes.length} entities`);
      // Yield a frame so the status text renders before the sync initScene work
      requestAnimationFrame(async () => {
        if (cancelled) return;
        setInitProgress("Computing graph layout");
        let transformed: TransformedData;
        try {
          transformed = await transformGraphDataInWorker(graphData, (worker) => {
            layoutWorker = worker;
          });
        } catch {
          if (cancelled) return;
          transformed = await transformGraphData(graphData, setInitProgress);
        }
        if (cancelled) return;
        persistTransformedData(graphKey, transformed);
        const result = initScene(transformed);
        if (!result) return;
        setupScene(result);
      });
    }).catch(() => {
      if (!cancelled) {
        hasInitRef.current = true;
        setInitProgress("Graph initialization failed");
        setGraphEmpty(true);
        setSceneReady(true);
        onReady?.();
      }
    });

    return () => {
      cancelled = true;
      layoutWorker?.terminate();
      layoutWorker = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initScene, prefetchedData, reinitTrigger]);

  useEffect(() => {
    const state = stateRef.current;
    if (!visible || !sceneReady || !state || state.disposed || state.animId) return;
    state.clock.getDelta();
    state.animId = requestAnimationFrame(state.animate);
  }, [sceneReady, visible]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const setupScene = (result: NonNullable<ReturnType<typeof initScene>>) => {
    const { state, buildData } = result;

    const canvas = canvasRef.current!;
    const container = containerRef.current!;

    // Async incremental scene building
    const abortCtrl = new AbortController();
    (async () => {
      const sig = abortCtrl.signal;
      const yield_ = () => new Promise<void>(r => requestAnimationFrame(() => r()));
      const { interEdges, intraEdges, clusterGroupColor,
        nodeGroup, edgeGroup, contourGroup, textPlaneGeo,
        rand, lerp3, mkBundleLine, getNodeGeometry } = buildData;

      // Nodes — batches of 10
      const totalNodes = state.allNodeDefs.length;
      const totalEdges = interEdges.reduce((s, b) => s + b.edges.length, 0) + intraEdges.length;
      setInitProgress(`Building nodes · 0 / ${totalNodes}`);
      for (let i = 0; i < state.allNodeDefs.length; i++) {
        if (sig.aborted) return;
        const def = state.allNodeDefs[i];
        const visual = getNodeVisualSpec(def);
        const tex = makeTextTexture(def.id, def.intensity);
        const mat = makeTextMat(tex, def.intensity, visual.color);
        const mesh = new THREE.Mesh(textPlaneGeo, mat);
        mesh.position.copy(def.pos);
        mesh.scale.set(0.001, 0.001, 0.001);
        const baseScale = 1.1 + def.intensity * 0.4;
        mesh.userData = { def, baseScale, visualShape: visual.shape };
        mesh.raycast = () => { };
        nodeGroup.add(mesh);

        const dotSize = (0.055 + def.intensity * 0.04) * visual.scale;
        const dotGeo = getNodeGeometry(visual.shape, dotSize);
        const dotMat = makeIridMat(def.intensity, visual.color);
        dotMat.depthTest = false;
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.position.copy(def.pos);
        dot.rotation.y = def.rotY;
        dot.rotation.x = visual.tiltX;
        dot.rotation.z = visual.tiltZ;
        dot.scale.set(0.001, 0.001, 0.001);
        dot.userData = {
          def,
          parentIdx: i,
          isDot: true,
          visualShape: visual.shape,
          visualKey: visual.key,
          baseRotX: visual.tiltX,
          baseRotZ: visual.tiltZ,
        };
        nodeGroup.add(dot);
        mesh.userData.dot = dot;
        state.dotMeshes.push(dot);
        state.nodeMeshes.push(mesh);
        if (i % 10 === 9) {
          setInitProgress(`Building nodes · ${i + 1} / ${totalNodes}`);
          await yield_();
        }
      }

      // Inter-cluster edges — bundled through cluster centers
      setInitProgress(`Building edges · 0 / ${totalEdges}`);
      let lineCount = 0;
      for (const bd of interEdges) {
        if (sig.aborted) return;
        const sc = state.clusters[bd.src], dc = state.clusters[bd.dst];
        if (!sc || !dc) continue;
        const mid = lerp3(sc.center, dc.center, 0.5); mid.y += rand(-0.15, 0.15);
        const blendedColor = (clusterGroupColor[bd.src] || new THREE.Color(0.5, 0.8, 1.0)).clone().lerp(clusterGroupColor[bd.dst] || new THREE.Color(0.5, 0.8, 1.0), 0.5);
        for (let k = 0; k < bd.edges.length; k++) {
          const edge = bd.edges[k];
          const sn = state.allNodeDefs[edge.srcIdx];
          const dn = state.allNodeDefs[edge.dstIdx];
          if (!sn || !dn) continue;
          const line = mkBundleLine(sn.pos, dn.pos, sc.center, dc.center, mid, (sn.intensity + dn.intensity) / 2, blendedColor);
          line.userData.birthTime = bd.birthTime + k * 0.003;
          line.userData.srcIdx = sn.idx;
          line.userData.dstIdx = dn.idx;
          state.allLines.push(line);
          sn.connections.push({ target: dn.idx, relation: edge.relation });
          dn.connections.push({ target: sn.idx, relation: edge.relation });
          lineCount++;
          if (lineCount % 20 === 19) {
            setInitProgress(`Building edges · ${lineCount} / ${totalEdges}`);
            await yield_();
          }
        }
      }

      // Intra-cluster edges — simple curves. Centripetal parametrization
      // to keep the endpoint tangents pointing toward the neighbour instead
      // of looping backward (which uniform Catmull-Rom does on near-linear
      // 3-point polygons).
      for (const ed of intraEdges) {
        if (sig.aborted) return;
        const a = state.allNodeDefs[ed.srcIdx], b = state.allNodeDefs[ed.dstIdx];
        if (!a || !b || a === b) continue;
        const mid = lerp3(a.pos, b.pos, 0.5);
        const curve = new THREE.CatmullRomCurve3([a.pos.clone(), mid, b.pos.clone()], false, "centripetal");
        const pts = curve.getPoints(16);
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const lineMat = new THREE.LineBasicMaterial({ color: clusterGroupColor[ed.cluster] || new THREE.Color(0.5, 0.8, 1.0), transparent: true, opacity: 0, depthWrite: false });
        const line = new THREE.Line(geo, lineMat);
        line.userData = { birthTime: ed.birthTime, totalPts: 17, srcIdx: a.idx, dstIdx: b.idx };
        line.geometry.setDrawRange(0, 0);
        edgeGroup.add(line);
        a.connections.push({ target: b.idx, relation: ed.relation });
        b.connections.push({ target: a.idx, relation: ed.relation });
        state.allLines.push(line);
        lineCount++;
        if (lineCount % 20 === 19) {
          setInitProgress(`Building edges · ${lineCount} / ${totalEdges}`);
          await yield_();
        }
      }

      // Build adjacency map for hover neighborhood lookup
      for (const def of state.allNodeDefs) {
        state.adjacency.set(def.idx, def.connections.map(c => c.target));
      }

      // Contours (synchronous — fast enough to not need batching)
      // Quantized size tiers based on centrality — stored on def for dot scaling
      const maxConns = Math.max(1, ...state.allNodeDefs.map(d => d.connections.length));
      for (let i = 0; i < state.allNodeDefs.length; i++) {
        const def = state.allNodeDefs[i];
        const centrality = def.connections.length / maxConns;
        // 4 tiers: 1.0, 1.4, 2.0, 3.0
        const tier = centrality > 0.6 ? 3.0 : centrality > 0.3 ? 2.0 : centrality > 0.1 ? 1.4 : 1.0;
        (def as any).centralityTier = tier;
        const mesh = state.nodeMeshes[i];
        if (mesh) mesh.userData.baseScale *= tier;
      }

      setInitProgress("Building contours");
      if (sig.aborted) return;
      state.groupDefs.forEach((g) => {
        if (g.members.length < 3) return;
        const pts2d = g.members.map(n => [n.pos.x, n.pos.z]);
        const hull = convexHull2D(pts2d);
        if (hull.length < 3) return;

        let yMax = -Infinity;
        g.members.forEach(n => { yMax = Math.max(yMax, n.pos.y); });
        const topY = yMax + 0.6;
        const bottomY = -1.5;

        const hullPts3D = hull.map(([hx, hz]) => ({ x: hx, y: topY, z: hz }));
        const cx = hullPts3D.reduce((s, p) => s + p.x, 0) / hullPts3D.length;
        const cz = hullPts3D.reduce((s, p) => s + p.z, 0) / hullPts3D.length;
        const pad = 0.7;
        const expanded = hullPts3D.map(p => {
          const dx = p.x - cx, dz = p.z - cz;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          return new THREE.Vector3(p.x + dx / len * pad, p.y, p.z + dz / len * pad);
        });

        const curve = new THREE.CatmullRomCurve3(expanded, true, "catmullrom", 0.5);
        const curvePts = curve.getPoints(96);
        const col = new THREE.Color(g.color.x, g.color.y, g.color.z);

        const cGeo = new THREE.BufferGeometry().setFromPoints(curvePts);
        const cMat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false });
        contourGroup.add(new THREE.Line(cGeo, cMat));

        const fencePts: number[] = [];
        for (let i = 0; i < curvePts.length; i += 3) {
          const p = curvePts[i];
          fencePts.push(p.x, p.y, p.z, p.x, bottomY, p.z);
        }
        const fenceGeo = new THREE.BufferGeometry();
        fenceGeo.setAttribute("position", new THREE.Float32BufferAttribute(fencePts, 3));
        const fenceMat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false });
        contourGroup.add(new THREE.LineSegments(fenceGeo, fenceMat));

        const groundPts = curvePts.map(p => new THREE.Vector3(p.x, bottomY + 0.01, p.z));
        const gGeo = new THREE.BufferGeometry().setFromPoints(groundPts);
        const gMat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false });
        contourGroup.add(new THREE.Line(gGeo, gMat));

        const wallVerts: number[] = [], wallNormals: number[] = [], wallIdx: number[] = [];
        for (let i = 0; i < curvePts.length; i++) {
          const p = curvePts[i];
          wallVerts.push(p.x, p.y, p.z, p.x, bottomY, p.z);
          const nx = p.x - cx, nz = p.z - cz;
          const nl = Math.sqrt(nx * nx + nz * nz) || 1;
          wallNormals.push(nx / nl, 0, nz / nl, nx / nl, 0, nz / nl);
        }
        for (let i = 0; i < curvePts.length - 1; i++) {
          const t0 = i * 2, b0 = t0 + 1, t1 = (i + 1) * 2, b1 = t1 + 1;
          wallIdx.push(t0, b0, t1, t1, b0, b1);
        }
        const last = (curvePts.length - 1) * 2;
        wallIdx.push(last, last + 1, 0, 0, last + 1, 1);

        const wallGeo = new THREE.BufferGeometry();
        wallGeo.setAttribute("position", new THREE.Float32BufferAttribute(wallVerts, 3));
        wallGeo.setAttribute("normal", new THREE.Float32BufferAttribute(wallNormals, 3));
        wallGeo.setIndex(wallIdx);
        const wallMat = new THREE.MeshPhongMaterial({
          color: col, transparent: true, opacity: 0, depthWrite: false,
          side: THREE.DoubleSide, shininess: 30,
          emissive: new THREE.Color(g.color.x * 0.15, g.color.y * 0.15, g.color.z * 0.15),
        });
        contourGroup.add(new THREE.Mesh(wallGeo, wallMat));

        const capShape = new THREE.Shape();
        capShape.moveTo(curvePts[0].x, curvePts[0].z);
        for (let i = 1; i < curvePts.length; i++) capShape.lineTo(curvePts[i].x, curvePts[i].z);
        capShape.closePath();
        const capGeo = new THREE.ShapeGeometry(capShape);
        capGeo.rotateX(-Math.PI / 2);
        capGeo.scale(1, 1, -1);
        capGeo.translate(0, topY, 0);
        const capMat = new THREE.MeshPhongMaterial({
          color: col, transparent: true, opacity: 0, depthWrite: false,
          side: THREE.DoubleSide, shininess: 20,
          emissive: new THREE.Color(g.color.x * 0.1, g.color.y * 0.1, g.color.z * 0.1),
        });
        contourGroup.add(new THREE.Mesh(capGeo, capMat));

        state.contourMeshes.push({ main: cMat, fence: fenceMat, ground: gMat, wall: wallMat, cap: capMat, targetOp: 0, currentOp: 0 });
      });

      if (!sig.aborted) {
        // Start the animation loop now that all geometry is ready
        state.animId = requestAnimationFrame(state.animate);
        setSceneReady(true);
        onReady?.();
        // Auto-play the timeline for a smooth cinematic reveal
        state.playing = true;
        setPlaying(true);
        // Expose community info for toggle buttons
        setCommunities(state.groupDefs.map(g => ({
          name: g.name,
          color: `rgb(${Math.round(g.color.x * 255)}, ${Math.round(g.color.y * 255)}, ${Math.round(g.color.z * 255)})`,
        })));
      }
    })();

    // Resize handler
    const ro = new ResizeObserver(entries => {
      const { width: w, height: h } = entries[0].contentRect;
      if (w > 0 && h > 0 && stateRef.current) {
        const s = stateRef.current;
        // Cheap: update aspect ratio on next frame (no GPU work)
        s.pendingAspect = w / h;
        // Expensive: debounce setSize until resizing stops
        if (s.resizeTimer) clearTimeout(s.resizeTimer);
        s.resizeTimer = window.setTimeout(() => {
          s.resizeTimer = 0;
          s.renderer.setSize(w, h, false);
          s.renderer.render(s.scene, s.camera);
        }, 150);
      }
    });
    ro.observe(container);

    // Pointer events — use pointer capture to survive drags outside the canvas
    const onPointerDown = (e: PointerEvent) => {
      const s = stateRef.current;
      if (!s) return;
      // Blur any focused element (e.g. search bar) when interacting with the graph
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      // Prevent text selection, image drag, and other browser defaults
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.shiftKey) { s.isPan = true; s.isDrag = false; } else { s.isDrag = true; s.isPan = false; }
      s.pm = { x: e.clientX, y: e.clientY };
      s.dragDist = 0;
      s.clickTarget = s.hoveredNode;
      canvas.style.cursor = s.isPan ? "move" : "grabbing";
    };

    const onPointerUp = (e: PointerEvent) => {
      const s = stateRef.current;
      if (!s) return;
      canvas.releasePointerCapture(e.pointerId);
      s.isDrag = false; s.isPan = false;
      canvas.style.cursor = s.hoveredNode ? "pointer" : "grab";
    };

    const onPointerMove = (e: PointerEvent) => {
      const s = stateRef.current;
      if (!s) return;
      const dx = e.clientX - s.pm.x, dy = e.clientY - s.pm.y;
      s.dragDist += Math.abs(dx) + Math.abs(dy);
      if (s.isDrag && !s.zoomAnimating) {
        s.rY += dx * 0.004;
        s.rX = Math.max(-0.6, Math.min(1.2, s.rX + dy * 0.004));
      }
      if (s.isPan && !s.zoomAnimating) {
        const right = new THREE.Vector3(), up = new THREE.Vector3();
        s.camera.getWorldDirection(up);
        right.crossVectors(up, s.camera.up).normalize();
        up.copy(s.camera.up).normalize();
        const ps = s.dZ * 0.0008;
        s.panOffset.add(right.multiplyScalar(-dx * ps));
        s.panOffset.add(up.multiplyScalar(dy * ps));
      }
      s.pm = { x: e.clientX, y: e.clientY };

      // Update mouse for raycasting using container-relative coordinates
      const rect = canvas.getBoundingClientRect();
      s.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      s.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const onWheel = (e: WheelEvent) => {
      const s = stateRef.current;
      if (!s || s.zoomAnimating) return;
      s.dZ = Math.max(5, Math.min(40, s.dZ + e.deltaY * 0.012));
    };

    const onClick = () => {
      const s = stateRef.current;
      if (!s || s.dragDist > 5) return;
      const target = s.clickTarget;
      if (!target) return;
      const def = target.userData.def as NodeDef;
      selectNode(def);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") unselectNode();
    };

    // Prevent native drag (image-drag ghost) and text selection on the canvas.
    // On Linux/GTK, pointerdown.preventDefault() alone doesn't suppress the
    // underlying mousedown drag detection, so we block mousedown default too.
    const onDragStart = (e: Event) => e.preventDefault();
    const onSelectStart = (e: Event) => e.preventDefault();
    const onMouseDown = (e: MouseEvent) => e.preventDefault();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("mousedown", onMouseDown);
    // Pointer capture routes move/up events to the canvas even when pointer leaves
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointermove", onPointerMove);
    // Also listen on window as fallback for edge cases (e.g. pointer capture lost)
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: true });
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("contextmenu", e => e.preventDefault());
    canvas.addEventListener("dragstart", onDragStart);
    canvas.addEventListener("drag", onDragStart);
    canvas.addEventListener("selectstart", onSelectStart);
    // Also prevent drag/select on the container in case events miss the canvas
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("dragstart", onDragStart);
    container.addEventListener("drag", onDragStart);
    container.addEventListener("selectstart", onSelectStart);
    window.addEventListener("keydown", onKeyDown);

    cleanupRef.current = () => {
      abortCtrl.abort();
      const s = stateRef.current;
      if (s) {
        s.disposed = true;
        cancelAnimationFrame(s.animId);
        if (s.resizeTimer) clearTimeout(s.resizeTimer);
        s.renderer.dispose();
      }
      stateRef.current = null;
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("dragstart", onDragStart);
      canvas.removeEventListener("drag", onDragStart);
      canvas.removeEventListener("selectstart", onSelectStart);
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("dragstart", onDragStart);
      container.removeEventListener("drag", onDragStart);
      container.removeEventListener("selectstart", onSelectStart);
      window.removeEventListener("keydown", onKeyDown);
    };
  };

  // Resume animation loop when becoming visible again
  useEffect(() => {
    const s = stateRef.current;
    if (visible && s && !s.disposed && s.animate) {
      s.clock.getDelta(); // drain stale delta
      s.animId = requestAnimationFrame(s.animate);
    }
  }, [visible]);

  // ── Node selection ──

  const selectNode = useCallback((def: NodeDef) => {
    const s = stateRef.current;
    if (!s) return;

    s.selectedDef = def;

    // Cache connectedSet and focusedGroupSet so animate() doesn't rebuild them every frame
    const cs = new Set([def.idx]);
    def.connections.forEach(c => cs.add(c.target));
    s.connectedSet = cs;

    // Cap selection labels: selected node + closest N neighbors
    const MAX_SEL_LABELS = 10;
    const selPos = def.pos;
    const neighborDefs = def.connections
      .map(c => s.allNodeDefs[c.target])
      .filter(d => d != null)
      .sort((a, b) => a.pos.distanceToSquared(selPos) - b.pos.distanceToSquared(selPos))
      .slice(0, MAX_SEL_LABELS);
    s.selectionLabelSet = new Set([def.idx, ...neighborDefs.map(d => d.idx)]);

    const fgs = new Set(s.nodeGroupMembership[def.idx] || []);
    def.connections.forEach(c => {
      (s.nodeGroupMembership[c.target] || []).forEach(gi => fgs.add(gi));
    });
    s.focusedGroupSet = fgs;

    const target = def.pos.clone();
    const dx = target.x, dz = target.z;
    const tRY = Math.atan2(dx, dz);
    const tRX = 0.3;
    // Zoom out more when the node has many connections to avoid crowding
    const connCount = def.connections.length;
    const tDZ = Math.min(20, 7 + Math.sqrt(Math.max(0, connCount - 5)) * 1.5);

    // Panel compensation — shift pan target so node appears centered in the non-panel area
    const vFov = s.camera.fov * Math.PI / 180;
    const fwd = new THREE.Vector3(Math.sin(tRY) * Math.cos(tRX), Math.sin(tRX) * 0.5, Math.cos(tRY) * Math.cos(tRX)).normalize();
    const right = new THREE.Vector3();
    right.crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const PANEL_W = 340;
    const canvas = canvasRef.current;
    const canvasH = canvas ? canvas.clientHeight : window.innerHeight;
    const comp = right.multiplyScalar(-(PANEL_W / 2) * (2 * Math.tan(vFov / 2) * tDZ / canvasH));

    const panTo = target.clone().add(comp);
    s.zoomFrom = { rY: s.rY, rX: s.rX, dZ: s.dZ, pan: s.panOffset.clone() };
    s.zoomTo = { rY: tRY, rX: tRX, dZ: tDZ, pan: panTo };
    while (s.zoomTo.rY - s.zoomFrom.rY > Math.PI) s.zoomTo.rY -= Math.PI * 2;
    while (s.zoomTo.rY - s.zoomFrom.rY < -Math.PI) s.zoomTo.rY += Math.PI * 2;
    s.zoomAnimating = true;
    s.zoomProgress = 0;

    // Build unique connections with relation labels
    const uniqConnections = new Map<number, string>();
    def.connections.forEach(c => {
      if (!uniqConnections.has(c.target)) uniqConnections.set(c.target, c.relation || 'related');
    });

    setSelectedNode({
      name: def.id, // id holds display name (entity name)
      entityId: def.entityId || def.id,
      entityType: def.entityType || def.protocol || 'unknown',
      nodeType: def.nodeType || def.status || 'entity',
      cluster: s.clusters[def.cluster]?.name || `Community ${def.cluster}`,
      frequency: def.frequency || 0,
      intensity: def.intensity,
      synonyms: def.synonyms || [],
      threadCount: def.threadCount || 0,
      neighborCount: def.neighborCount || uniqConnections.size,
      connections: [...uniqConnections.entries()].slice(0, 8).map(([tIdx, relation]) => {
        const tDef = s.allNodeDefs[tIdx];
        return {
          name: tDef?.id || '???',
          relation,
          entityType: tDef?.entityType,
          nodeType: tDef?.nodeType,
          idx: tIdx,
        };
      }),
      platform: def.platform,
      filePath: def.filePath,
    });
  }, []);

  const highlightNodeIds = useCallback((nodeIds: string[], focusFirst = true) => {
    const s = stateRef.current;
    if (!s) return;

    const defsById = new Map<string, NodeDef>();
    for (const def of s.allNodeDefs) {
      defsById.set(def.entityId || def.id, def);
      defsById.set(def.id, def);
    }

    const highlightedDefs = nodeIds
      .map((nodeId) => defsById.get(nodeId.trim()))
      .filter((def): def is NodeDef => !!def);

    agentHighlightIndicesRef.current = new Set(highlightedDefs.map((def) => def.idx));
    agentHighlightUntilRef.current = performance.now() + 15_000;

    if (highlightedDefs.length === 0) return;
    if (focusFirst) {
      selectNode(highlightedDefs[0]);
      return;
    }

    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const def of highlightedDefs) {
      min.min(def.pos);
      max.max(def.pos);
    }
    const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    const size = new THREE.Vector3().subVectors(max, min);
    const extent = Math.max(size.x, size.y, size.z, 2);

    s.zoomFrom = { rY: s.rY, rX: s.rX, dZ: s.dZ, pan: s.panOffset.clone() };
    s.zoomTo = {
      rY: Math.atan2(center.x, center.z),
      rX: 0.35,
      dZ: Math.max(6, extent * 1.4 + 4),
      pan: center,
    };
    while (s.zoomTo.rY - s.zoomFrom.rY > Math.PI) s.zoomTo.rY -= Math.PI * 2;
    while (s.zoomTo.rY - s.zoomFrom.rY < -Math.PI) s.zoomTo.rY += Math.PI * 2;
    s.zoomAnimating = true;
    s.zoomProgress = 0;
  }, [selectNode]);

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ node_ids?: string[]; focus?: boolean }>("kg-agent-highlight", (event) => {
        highlightNodeIds(event.payload.node_ids ?? [], event.payload.focus ?? true);
      });
    })();
    return () => { unlisten?.(); };
  }, [highlightNodeIds]);

  const unselectNode = useCallback(() => {
    const s = stateRef.current;
    if (s) {
      // Animate camera out slightly from current position, keeping the same general area
      s.zoomFrom = { rY: s.rY, rX: s.rX, dZ: s.dZ, pan: s.panOffset.clone() };
      s.zoomTo = { rY: s.rY, rX: Math.min(s.rX + 0.05, 0.8), dZ: Math.min(s.dZ * 1.6, 28), pan: s.panOffset.clone() };
      s.zoomAnimating = true;
      s.zoomProgress = 0;
      s.selectedDef = null;
      s.connectedSet = null;
      s.selectionLabelSet = null;
      s.focusedGroupSet = null;
    }
    setSelectedNode(null);
  }, []);

  return (
    <div className="relative flex w-full h-full overflow-hidden" style={{ minHeight: 0, userSelect: "none", WebkitUserDrag: "none" } as React.CSSProperties} onDragStart={e => e.preventDefault()}>
      {/* Canvas */}
      <div ref={containerRef} draggable={false} className="flex-1 min-w-0 h-full" style={{ cursor: graphEmpty ? "default" : "grab", touchAction: "none", position: "relative", zIndex: 1, userSelect: "none", WebkitUserDrag: "none", pointerEvents: graphEmpty ? "none" : "auto" } as React.CSSProperties}>
        <canvas ref={canvasRef} draggable={false} className="block w-full h-full" style={{ touchAction: "none", userSelect: "none", WebkitUserDrag: "none", background: "#020A0D" } as React.CSSProperties} />
      </div>

      {/* Loading overlay */}
      <div
        className="absolute inset-0 pointer-events-none flex items-center justify-center"
        style={{ zIndex: 6, opacity: sceneReady ? 0 : 1, transition: "opacity 0.4s ease-out" }}
      >
        {!sceneReady && !graphEmpty && (
          <div ref={initProgressRef} style={{
            fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase",
            color: "rgba(195,236,255,0.25)", fontWeight: 300, whiteSpace: "nowrap",
          }}>
            Initializing graph
          </div>
        )}
      </div>

      {/* Empty state overlay */}
      {graphEmpty && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: 30 }}>
          <div style={{ textAlign: "center", color: "rgba(195,236,255,0.4)", maxWidth: 400 }}>
            <div style={{ fontSize: 20, fontWeight: 500, marginBottom: 12, letterSpacing: "-0.02em" }}>
              {hasConversations ? "Knowledge graph not built" : "No conversations yet"}
            </div>
            <div style={{ fontSize: 15, color: "rgba(195,236,255,0.25)", lineHeight: 1.6 }}>
              {hasConversations
                ? "Your vault has conversations, but the knowledge graph hasn't been built yet."
                : "Start a conversation in Chat, or install the browser extension to sync conversations from ChatGPT, Claude, and Gemini."
              }
            </div>
            {hasConversations && !hasApiKey && (
              <>
                <div style={{ fontSize: 14, color: "rgba(195,236,255,0.3)", lineHeight: 1.6, marginTop: 12 }}>
                  An API key is required to build the knowledge graph.
                </div>
                <button
                  onClick={() => onNavigateSettings?.()}
                  style={{
                    marginTop: 20,
                    padding: "10px 24px",
                    borderRadius: 12,
                    border: "1px solid rgba(195,236,255,0.15)",
                    background: "rgba(195,236,255,0.06)",
                    color: "rgba(195,236,255,0.7)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: "pointer",
                    transition: "all 200ms ease",
                    letterSpacing: "-0.01em",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(195,236,255,0.1)";
                    e.currentTarget.style.borderColor = "rgba(195,236,255,0.25)";
                    e.currentTarget.style.color = "rgba(195,236,255,0.9)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(195,236,255,0.06)";
                    e.currentTarget.style.borderColor = "rgba(195,236,255,0.15)";
                    e.currentTarget.style.color = "rgba(195,236,255,0.7)";
                  }}
                >
                  Configure API Access
                </button>
              </>
            )}
            {hasConversations && hasApiKey && (
              <>
                <button
                  disabled={building}
                  onClick={async () => {
                    setBuilding(true);
                    setBuildError(null);
                    try {
                      await cmdKgIndexVault(false);
                      setGraphEmpty(false);
                      setSceneReady(false);
                      setBuilding(false);
                      hasInitRef.current = false;
                      setReinitTrigger(n => n + 1);
                    } catch (e) {
                      setBuildError(String(e));
                      setBuilding(false);
                    }
                  }}
                  style={{
                    marginTop: 20,
                    padding: "10px 24px",
                    borderRadius: 12,
                    border: "1px solid rgba(195,236,255,0.15)",
                    background: "rgba(195,236,255,0.06)",
                    color: building ? "rgba(195,236,255,0.4)" : "rgba(195,236,255,0.7)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: building ? "wait" : "pointer",
                    transition: "all 200ms ease",
                    letterSpacing: "-0.01em",
                  }}
                  onMouseEnter={(e) => {
                    if (building) return;
                    e.currentTarget.style.background = "rgba(195,236,255,0.1)";
                    e.currentTarget.style.borderColor = "rgba(195,236,255,0.25)";
                    e.currentTarget.style.color = "rgba(195,236,255,0.9)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(195,236,255,0.06)";
                    e.currentTarget.style.borderColor = "rgba(195,236,255,0.15)";
                    e.currentTarget.style.color = building ? "rgba(195,236,255,0.4)" : "rgba(195,236,255,0.7)";
                  }}
                >
                  {building ? "Building..." : "Build Graph"}
                </button>
                {buildError && (
                  <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,120,120,0.7)", maxWidth: 320 }}>
                    {buildError}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Fog of war — edge vignette that blends the 3D scene into the app chrome */}
      <div className="absolute inset-x-0 top-0 pointer-events-none" style={{ height: "clamp(120px, 35vh, 400px)", background: "linear-gradient(to bottom, var(--color-base) 0%, var(--color-base) 10%, rgba(2,10,13,0.7) 30%, rgba(2,10,13,0.3) 55%, rgba(2,10,13,0.08) 75%, transparent 100%)", zIndex: 4 }} />
      <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{ height: "clamp(100px, 28vh, 320px)", background: "linear-gradient(to top, var(--color-base) 0%, var(--color-base) 10%, rgba(2,10,13,0.7) 30%, rgba(2,10,13,0.3) 55%, rgba(2,10,13,0.08) 75%, transparent 100%)", zIndex: 4 }} />
      <div className="absolute inset-y-0 left-0 pointer-events-none" style={{ width: "clamp(100px, 25vw, 420px)", background: "linear-gradient(to right, var(--color-base) 0%, var(--color-base) 8%, rgba(2,10,13,0.85) 20%, rgba(2,10,13,0.55) 40%, rgba(2,10,13,0.25) 60%, rgba(2,10,13,0.08) 80%, transparent 100%)", zIndex: 4 }} />
      <div className="absolute inset-y-0 right-0 pointer-events-none" style={{ width: "clamp(100px, 25vw, 420px)", background: "linear-gradient(to left, var(--color-base) 0%, var(--color-base) 8%, rgba(2,10,13,0.85) 20%, rgba(2,10,13,0.55) 40%, rgba(2,10,13,0.25) 60%, rgba(2,10,13,0.08) 80%, transparent 100%)", zIndex: 4 }} />

      {/* Node detail panel */}
      <div
        className="absolute right-0 flex flex-col overflow-hidden overflow-y-auto scrollbar-none"
        style={{
          top: "clamp(64px, 15vh, 120px)",
          bottom: "clamp(48px, 10vh, 80px)",
          width: 320,
          background: "rgba(2, 10, 13, 0.78)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(195, 236, 255, 0.06)",
          borderRadius: 20,
          marginRight: 12,
          padding: "24px 24px 32px",
          transform: selectedNode ? "translateX(0)" : "translateX(calc(100% + 12px))",
          transition: "transform 500ms cubic-bezier(0.22, 1, 0.36, 1)",
          zIndex: 20,
        }}
      >
        <button
          onClick={unselectNode}
          className="absolute cursor-pointer"
          style={{
            top: 16, right: 16,
            background: "none",
            border: "none",
            color: "rgba(195, 236, 255, 0.35)",
            width: 28, height: 28, borderRadius: 8,
            padding: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "color 200ms ease, background 200ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "rgba(195, 236, 255, 0.8)";
            e.currentTarget.style.background = "rgba(195, 236, 255, 0.08)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "rgba(195, 236, 255, 0.35)";
            e.currentTarget.style.background = "none";
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        {selectedNode && (
          <>
            {/* Title — paddingRight reserves space for the absolute close
                button at top:16/right:16 (28px + 8px gap) so long names
                don't run under it. */}
            <div title={selectedNode.name.length > 50 ? selectedNode.name : undefined} style={{ fontSize: 16, fontWeight: 500, color: "rgba(195,236,255,0.85)", marginBottom: 16, lineHeight: 1.3, paddingRight: 36 }}>
              {selectedNode.name.length > 50 ? selectedNode.name.slice(0, 50) + "..." : selectedNode.name}
            </div>

            {/* Preview — markdown-rendered first user message, clickable to open */}
            {nodePreview && selectedNode.filePath && (
              <div
                role="button"
                tabIndex={0}
                onClick={() => onOpenConversation?.(selectedNode.filePath!)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenConversation?.(selectedNode.filePath!);
                  }
                }}
                className="cursor-pointer"
                style={{
                  position: "relative",
                  background: "rgba(195,236,255,0.03)",
                  border: "1px solid rgba(195,236,255,0.06)",
                  borderRadius: 6,
                  padding: "10px 12px",
                  marginBottom: 16,
                  maxHeight: 240,
                  overflow: "hidden",
                  transition: "border-color 200ms",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "rgba(195,236,255,0.15)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "rgba(195,236,255,0.06)";
                }}
              >
                <div
                  className="chat-markdown"
                  style={{
                    fontSize: 11.5,
                    lineHeight: 1.6,
                    color: "rgba(195,236,255,0.65)",
                    // Let MarkdownRenderer's chat-markdown base styles apply
                    // but don't let long content push panel layout around.
                    pointerEvents: "none",
                  }}
                >
                  <MarkdownRenderer content={nodePreview} />
                </div>
                {/* Bottom fade so a clamped preview reads as "more below" */}
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: 48,
                    pointerEvents: "none",
                    background: "linear-gradient(to bottom, rgba(10,20,26,0) 0%, rgba(10,20,26,0.92) 80%, rgba(10,20,26,1) 100%)",
                    borderBottomLeftRadius: 6,
                    borderBottomRightRadius: 6,
                  }}
                />
              </div>
            )}

            {/* Neighbors */}
            <PanelField label="NEIGHBORS" value={`${selectedNode.neighborCount} connected node${selectedNode.neighborCount !== 1 ? 's' : ''}`} />

            {/* File path — one clickable row that opens the conversation in-app */}
            {selectedNode.filePath && (
              <>
                <div style={{ fontSize: 8, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(195,236,255,0.19)", marginBottom: 4 }}>FILE</div>
                <button
                  onClick={() => onOpenConversation?.(selectedNode.filePath!)}
                  className="cursor-pointer"
                  title="Open conversation"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    marginBottom: 16,
                    padding: "6px 10px",
                    background: "rgba(195,236,255,0.02)",
                    border: "1px solid rgba(195,236,255,0.06)",
                    borderRadius: 4,
                    textAlign: "left",
                    transition: "color 200ms, border-color 200ms, background 200ms",
                    color: "rgba(195,236,255,0.45)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "rgba(195,236,255,0.85)";
                    e.currentTarget.style.borderColor = "rgba(195,236,255,0.18)";
                    e.currentTarget.style.background = "rgba(195,236,255,0.05)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "rgba(195,236,255,0.45)";
                    e.currentTarget.style.borderColor = "rgba(195,236,255,0.06)";
                    e.currentTarget.style.background = "rgba(195,236,255,0.02)";
                  }}
                >
                  <span style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 11,
                    letterSpacing: "0.06em",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "inherit",
                  }}>
                    {selectedNode.filePath.split('/').pop() || selectedNode.filePath}
                  </span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    style={{ flexShrink: 0, opacity: 0.75 }}
                    aria-hidden
                  >
                    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}

            {/* Connections — clickable */}
            <div style={{ width: "100%", height: 1, background: "rgba(195,236,255,0.04)", margin: "4px 0 16px" }} />
            <div style={{ fontSize: 8, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(195,236,255,0.19)", marginBottom: 8 }}>CONNECTIONS</div>
            {selectedNode.connections.length > 0 ? selectedNode.connections.map((c, i) => (
              <button
                key={i}
                onClick={() => {
                  const s = stateRef.current;
                  if (s && s.allNodeDefs[c.idx]) selectNode(s.allNodeDefs[c.idx]);
                }}
                className="cursor-pointer"
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  width: "100%", textAlign: "left",
                  padding: "6px 8px", borderBottom: "1px solid rgba(195,236,255,0.03)",
                  borderRadius: 6,
                  gap: 8, background: "none", border: "none",
                  transition: "background 200ms ease, color 200ms ease",
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = "rgba(195,236,255,0.08)";
                  const s = stateRef.current;
                  if (s) (s as any)._panelHighlightIdx = c.idx;
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = "none";
                  const s = stateRef.current;
                  if (s) (s as any)._panelHighlightIdx = -1;
                }}
              >
                <span style={{ fontSize: 10, color: "rgba(195,236,255,0.5)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                <span style={{ fontSize: 9, color: "rgba(195,236,255,0.22)", fontStyle: "italic", flexShrink: 0 }}>{c.relation}</span>
              </button>
            )) : (
              <span style={{ fontSize: 10, color: "rgba(195,236,255,0.27)" }}>NO CONNECTIONS</span>
            )}
          </>
        )}
      </div>

    </div>
  );
}

// ── Small sub-components ──

function PanelField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <div style={{ fontSize: 8, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(195,236,255,0.19)", marginBottom: 4 }}>{label}</div>
      <div style={{
        fontSize: mono ? 11 : 13,
        color: mono ? "rgba(195,236,255,0.33)" : "rgba(195,236,255,0.8)",
        fontWeight: 300,
        marginBottom: 16,
        lineHeight: 1.5,
        minHeight: "1.5em",
        letterSpacing: mono ? "0.06em" : undefined,
        fontFamily: mono ? "var(--font-mono)" : undefined,
      }}>{value}</div>
    </>
  );
}
