import type { GraphData, GraphEdge, GraphNode } from "../lib/types";

interface InterEdgeDef {
  src: number;
  dst: number;
  birthTime: number;
  edges: { srcIdx: number; dstIdx: number; relation: string }[];
}

interface IntraEdgeDef {
  cluster: number;
  birthTime: number;
  srcIdx: number;
  dstIdx: number;
  relation: string;
}

export interface SerializedNodeDef {
  pos: [number, number, number];
  intensity: number;
  cluster: number;
  birthTime: number;
  rotY: number;
  id: string;
  idx: number;
  protocol: string;
  status: string;
  connections: { target: number; relation?: string }[];
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

export interface SerializedClusterDef {
  center: [number, number, number];
  birthTime: number;
  nodeCount: number;
  name: string;
}

export interface SerializedTransformedData {
  clusters: SerializedClusterDef[];
  allNodeDefs: SerializedNodeDef[];
  interEdges: InterEdgeDef[];
  intraEdges: IntraEdgeDef[];
}

export interface GraphLayoutWorkerRequest {
  graphData: GraphData;
}

export interface GraphLayoutWorkerResponse {
  data?: SerializedTransformedData;
  error?: string;
}

const ICY_PALETTE: [number, number, number][] = [
  [0.494, 0.784, 1.0], [0.357, 0.722, 0.8], [0.416, 0.624, 0.749],
  [0.659, 0.867, 0.937], [0.45, 0.70, 0.90], [0.55, 0.80, 0.85],
  [0.40, 0.65, 0.82], [0.52, 0.76, 0.92], [0.38, 0.68, 0.78],
  [0.60, 0.85, 0.95], [0.48, 0.74, 0.88], [0.56, 0.82, 0.90],
];

function louvainCommunities(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const nodeSet = new Set(nodes.map((n) => n.id));
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
    iterations += 1;
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
        if (gain > bestGain) {
          bestGain = gain;
          bestComm = targetComm;
        }
      }
      if (bestComm !== currentComm) {
        community.set(nodeId, bestComm);
        commDegree.set(currentComm, (commDegree.get(currentComm) || 0) - ki);
        commDegree.set(bestComm, (commDegree.get(bestComm) || 0) + ki);
        improved = true;
      }
    }
  }

  const uniqueComms = [...new Set(community.values())];
  const reindex = new Map<number, number>();
  uniqueComms.forEach((c, i) => reindex.set(c, i));
  const result = new Map<string, number>();
  for (const [nodeId, comm] of community) result.set(nodeId, reindex.get(comm)!);
  return result;
}

function transformGraphData(graphData: GraphData): SerializedTransformedData {
  const { nodes, edges } = graphData;
  const communities = louvainCommunities(nodes, edges);

  const commMap = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const c = communities.get(node.id) ?? 0;
    if (!commMap.has(c)) commMap.set(c, []);
    commMap.get(c)!.push(node);
  }
  const sortedComms = [...commMap.entries()].sort((a, b) => b[1].length - a[1].length);
  const commReindex = new Map<number, number>();
  sortedComms.forEach(([oldIdx], newIdx) => commReindex.set(oldIdx, newIdx));

  const clusterCount = sortedComms.length;
  const nodesPerCluster = nodes.length / Math.max(1, clusterCount);
  const spread = Math.max(4, Math.min(14, Math.sqrt(nodes.length) * 0.6));
  const clusterRadius = Math.max(1.5, Math.sqrt(nodesPerCluster) * 0.45);

  let seed = 42;
  const sr = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const sr2 = (a: number, b: number) => a + sr() * (b - a);

  const clusters: SerializedClusterDef[] = sortedComms.map(([_, commNodes], ci) => {
    const angle = ci * (Math.PI * 2 / Math.max(1, clusterCount)) + sr2(-0.3, 0.3);
    const r = spread + sr2(-0.6, 0.6);
    const sorted = [...commNodes].sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0));
    return {
      center: [Math.cos(angle) * r, sr2(-1.5, 1.5), Math.sin(angle) * r],
      birthTime: 0.02 + (ci / Math.max(1, clusterCount)) * 0.3 + sr2(-0.02, 0.02),
      nodeCount: commNodes.length,
      name: sorted[0]?.name ?? `Cluster ${ci}`,
    };
  });

  const maxMsgCount = Math.max(1, ...nodes.map((n) => n.frequency ?? 1));
  const nodeIdToIdx = new Map<string, number>();
  const allNodeDefs: SerializedNodeDef[] = [];
  const clusterBirthMax = new Array<number>(clusters.length).fill(0);

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const origComm = communities.get(node.id) ?? 0;
    const ci = commReindex.get(origComm) ?? 0;
    const cl = clusters[ci];
    const msgNorm = (node.frequency ?? 1) / maxMsgCount;
    const intensity = 0.2 + 0.8 * Math.sqrt(msgNorm);

    const theta = sr2(0, Math.PI * 2);
    const rMin = clusterRadius * 0.15;
    const r = sr2(rMin, clusterRadius);
    const edgeness = (r - rMin) / (clusterRadius - rMin);
    const nodeY = cl.center[1] - clusterRadius * 0.5 + edgeness * clusterRadius * 0.8 + sr2(-0.8, 0.8);
    const nodeRatio = allNodeDefs.length / Math.max(1, nodes.length);
    const bt = cl.birthTime + nodeRatio * 0.12 + sr2(0, 0.05);
    const displayName = node.name === node.name.toLowerCase()
      ? node.name.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase())
      : node.name;

    const def: SerializedNodeDef = {
      pos: [
        cl.center[0] + Math.cos(theta) * r,
        nodeY,
        cl.center[2] + Math.sin(theta) * r,
      ],
      intensity,
      cluster: ci,
      birthTime: Math.min(bt, 0.82),
      rotY: sr2(0, Math.PI),
      id: displayName,
      idx: allNodeDefs.length,
      protocol: node.entity_type ?? node.node_type ?? "",
      status: node.node_type ?? "conversation",
      connections: [],
      entityId: node.id,
      entityType: node.entity_type ?? undefined,
      nodeType: node.node_type,
      frequency: node.frequency ?? undefined,
      synonyms: node.synonyms ?? undefined,
      threadCount: node.thread_count ?? undefined,
      neighborCount: node.neighbor_count ?? undefined,
      platform: node.platform ?? undefined,
      filePath: node.file_path ?? undefined,
    };
    allNodeDefs.push(def);
    if (def.birthTime > clusterBirthMax[ci]) clusterBirthMax[ci] = def.birthTime;
  }

  allNodeDefs.sort((a, b) => a.birthTime - b.birthTime);
  allNodeDefs.forEach((def, i) => {
    def.idx = i;
    if (def.entityId) nodeIdToIdx.set(def.entityId, i);
  });

  const interMap = new Map<string, { src: number; dst: number; edges: { srcIdx: number; dstIdx: number; relation: string }[] }>();
  const intraEdges: IntraEdgeDef[] = [];

  for (const edge of edges) {
    const srcIdx = nodeIdToIdx.get(edge.source);
    const dstIdx = nodeIdToIdx.get(edge.target);
    if (srcIdx === undefined || dstIdx === undefined) continue;
    const srcCluster = allNodeDefs[srcIdx].cluster;
    const dstCluster = allNodeDefs[dstIdx].cluster;
    if (srcCluster === dstCluster) {
      intraEdges.push({
        cluster: srcCluster,
        birthTime: Math.min(clusterBirthMax[srcCluster] + sr2(0.01, 0.05), 0.88),
        srcIdx,
        dstIdx,
        relation: edge.relation,
      });
    } else {
      const [a, b] = srcCluster < dstCluster ? [srcCluster, dstCluster] : [dstCluster, srcCluster];
      const key = `${a}-${b}`;
      if (!interMap.has(key)) interMap.set(key, { src: a, dst: b, edges: [] });
      interMap.get(key)!.edges.push({ srcIdx, dstIdx, relation: edge.relation });
    }
  }

  const interEdges: InterEdgeDef[] = [];
  for (const bundle of interMap.values()) {
    interEdges.push({
      src: bundle.src,
      dst: bundle.dst,
      birthTime: Math.min(Math.max(clusterBirthMax[bundle.src], clusterBirthMax[bundle.dst]) + sr2(0.03, 0.1), 0.92),
      edges: bundle.edges,
    });
  }

  void ICY_PALETTE;
  return { clusters, allNodeDefs, interEdges, intraEdges };
}

self.onmessage = (evt: MessageEvent<GraphLayoutWorkerRequest>) => {
  try {
    const data = transformGraphData(evt.data.graphData);
    const response: GraphLayoutWorkerResponse = { data };
    postMessage(response);
  } catch (error) {
    const response: GraphLayoutWorkerResponse = { error: String(error) };
    postMessage(response);
  }
};
