/**
 * bundle-worker.ts — Web Worker for KDEEB edge bundling.
 *
 * Auto-detects WebGPU and dispatches to GPU or CPU implementation.
 * Same output contract as the old fdeb-worker: { paths: {x,y}[][] }.
 */

import { kdeebBundle, type KdeebNode, type KdeebEdge, type KdeebOptions } from './kdeeb';

export interface BundleWorkerRequest {
  nodes: Record<string, KdeebNode>;
  edges: KdeebEdge[];
  opts: KdeebOptions;
  generation: number;  // monotonic counter, worker echoes back
}

export interface BundleWorkerResponse {
  paths: { x: number; y: number }[][];
  backend: 'webgpu' | 'cpu';
  timeMs: number;
  generation: number;  // echoed back
}

type KdeebGpuModule = {
  KdeebGpu: {
    create(): Promise<{
      bundle(
        nodes: Record<string, KdeebNode>,
        edges: KdeebEdge[],
        opts: KdeebOptions,
      ): Promise<{ paths: { x: number; y: number }[][]; backend: 'webgpu' }>;
      destroy(): void;
    }>;
  };
};

let gpuInstance: Awaited<ReturnType<KdeebGpuModule['KdeebGpu']['create']>> | null = null;
// Permanent fallback: once GPU fails, all future calls use CPU to avoid repeated failures
let gpuFailed = false;
type GpuInstance = Awaited<ReturnType<KdeebGpuModule['KdeebGpu']['create']>> | null;
let gpuCreating: Promise<GpuInstance> | null = null;

async function tryGpu(): Promise<typeof gpuInstance> {
  if (gpuFailed) return null;
  if (gpuInstance) return gpuInstance;
  if (gpuCreating) return gpuCreating;
  gpuCreating = (async () => {
    try {
      const mod = await import('./kdeeb-gpu') as KdeebGpuModule;
      gpuInstance = await mod.KdeebGpu.create();
      return gpuInstance;
    } catch {
      gpuFailed = true;
      return null;
    } finally {
      gpuCreating = null;
    }
  })();
  return gpuCreating;
}

self.onmessage = async (evt: MessageEvent<BundleWorkerRequest>) => {
  try {
    const { nodes, edges, opts, generation } = evt.data;
    const t0 = performance.now();

    // Try GPU first
    const gpu = await tryGpu();
    if (gpu) {
      try {
        const result = await gpu.bundle(nodes, edges, opts);
        const response: BundleWorkerResponse = {
          paths: result.paths,
          backend: 'webgpu',
          timeMs: performance.now() - t0,
          generation,
        };
        postMessage(response);
        return;
      } catch {
        // GPU bundle failed — fall through to CPU
        gpuFailed = true;
        gpuInstance = null;
      }
    }

    // CPU fallback
    const result = kdeebBundle(nodes, edges, opts);
    const response: BundleWorkerResponse = {
      paths: result.paths,
      backend: 'cpu',
      timeMs: performance.now() - t0,
      generation,
    };
    postMessage(response);
  } catch (err) {
    postMessage({ error: String(err), generation: evt.data.generation });
  }
};
