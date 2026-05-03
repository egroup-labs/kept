/**
 * kdeeb.ts — Kernel Density Estimation Edge Bundling (CPU).
 *
 * Matches the reference Python KDEEB algorithm exactly:
 *   1. Splat interior points into density grid (nearest-cell)
 *   2. Gaussian blur with annealing sigma
 *   3. Gradient via central differences
 *   4. Advect along NORMALIZED gradient × step
 *   5. Smooth: 0.5·center + 0.25·(left + right)
 *   6. Pin endpoints
 *   7. Arc-length resample to keep points evenly spaced
 *
 * All parameters auto-scale to the data's world-space extent.
 */

export interface KdeebNode {
  x: number;
  y: number;
}

export interface KdeebEdge {
  source: string;
  target: string;
}

export interface KdeebOptions {
  samples?: number;     // subdivision points per edge (default 64)
  iterations?: number;  // advection iterations (default 8)
  gradientTau?: number;
  endpointDampWidth?: number;  // kept for backward compat, ignored if pinZone set
  pinZone?: number;            // width of endpoint re-linearization zone [0, 0.5]
  directionalBins?: number;    // angular bins for directional KDEEB (0=off, default 4)
  adaptiveAttraction?: boolean; // scale step by inverse local density (default true)
  perpBias?: number;           // perpendicular bias [0,1]: 0=full gradient, 1=perp only (default 0.6)
  splatSkipZone?: number;      // fraction of edge ends to skip during splatting (default 0.22)
  postSmoothIters?: number;    // extra smoothing passes after main iterations (default 10)
  stepStartFactor?: number;    // step = worldExtent * factor (default 0.012)
}

interface Pt { x: number; y: number }

/** Fraction of lowest-density edges treated as stragglers */
export const STRAGGLER_FRACTION = 0.15;
/** Number of sample points used for straggler scoring (interior points per edge) */
export const STRAGGLER_SAMPLE_PTS = 8;

/**
 * Filter self-loops and degenerate edges, compute bounding box with 10% padding.
 */
function prepareBundleInput(
  nodes: Record<string, KdeebNode>,
  edges: KdeebEdge[],
): { dataEdges: KdeebEdge[]; origIndices: number[]; bbox: { minX: number; minY: number; maxX: number; maxY: number; bboxW: number; bboxH: number; worldExtent: number } } {
  const eps = 1e-6;
  const dataEdges: KdeebEdge[] = [];
  const origIndices: number[] = [];
  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const s = nodes[e.source];
    const t = nodes[e.target];
    if (s && t && (Math.abs(s.x - t.x) > eps || Math.abs(s.y - t.y) > eps)) {
      dataEdges.push(e);
      origIndices.push(ei);
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const key in nodes) {
    const n = nodes[key];
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const padX = (maxX - minX) * 0.1 || 50;
  const padY = (maxY - minY) * 0.1 || 50;
  minX -= padX; maxX += padX;
  minY -= padY; maxY += padY;
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const worldExtent = Math.max(bboxW, bboxH);

  return { dataEdges, origIndices, bbox: { minX, minY, maxX, maxY, bboxW, bboxH, worldExtent } };
}

/**
 * Detect straggler edges (lowest-density fraction) and pre-advance them
 * toward higher-density regions so they get pulled into bundles during
 * the main iteration loop. Mutates `pts` in-place.
 */
function detectAndPreAdvanceStragglers(
  pts: Float32Array,
  dataEdges: KdeebEdge[],
  nodes: Record<string, KdeebNode>,
  ne: number,
  SAMPLES: number,
  minX: number,
  minY: number,
  GRID_RES: number,
  GW: number,
  GH: number,
  sigmaStart: number,
  stepStart: number,
  density: Float32Array,
  blurred: Float32Array,
  blurTmp: Float32Array,
  gradX: Float32Array,
  gradY: Float32Array,
): void {
  // Splat
  density.fill(0);
  for (let ei = 0; ei < ne; ei++) {
    const base = ei * SAMPLES * 2;
    for (let pi = 1; pi < SAMPLES - 1; pi++) {
      const px = pts[base + pi * 2];
      const py = pts[base + pi * 2 + 1];
      const gx = Math.floor((px - minX) / GRID_RES) | 0;
      const gy = Math.floor((py - minY) / GRID_RES) | 0;
      if (gx >= 0 && gx < GW && gy >= 0 && gy < GH) {
        density[gy * GW + gx] += 1.0;
      }
    }
  }

  // Blur with wide sigma
  const preSigma = sigmaStart * 1.5 / GRID_RES;
  const preRadius = Math.ceil(preSigma * 3);
  const preKSize = preRadius * 2 + 1;
  const preKernel = new Float32Array(preKSize);
  let preKSum = 0;
  for (let i = 0; i < preKSize; i++) {
    const d = i - preRadius;
    preKernel[i] = Math.exp(-0.5 * (d * d) / (preSigma * preSigma));
    preKSum += preKernel[i];
  }
  for (let i = 0; i < preKSize; i++) preKernel[i] /= preKSum;

  // Horizontal blur: density -> blurTmp
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      let sum = 0;
      for (let k = -preRadius; k <= preRadius; k++) {
        const sx = Math.max(0, Math.min(GW - 1, x + k));
        sum += density[y * GW + sx] * preKernel[k + preRadius];
      }
      blurTmp[y * GW + x] = sum;
    }
  }
  // Vertical blur: blurTmp -> blurred
  for (let x = 0; x < GW; x++) {
    for (let y = 0; y < GH; y++) {
      let sum = 0;
      for (let k = -preRadius; k <= preRadius; k++) {
        const sy = Math.max(0, Math.min(GH - 1, y + k));
        sum += blurTmp[sy * GW + x] * preKernel[k + preRadius];
      }
      blurred[y * GW + x] = sum;
    }
  }

  // Score each edge: average blurred density along its path
  const edgeScores = new Float32Array(ne);
  for (let ei = 0; ei < ne; ei++) {
    const base = ei * SAMPLES * 2;
    let total = 0;
    let count = 0;
    for (let pi = 1; pi < SAMPLES - 1; pi++) {
      const gx = Math.floor((pts[base + pi * 2] - minX) / GRID_RES) | 0;
      const gy = Math.floor((pts[base + pi * 2 + 1] - minY) / GRID_RES) | 0;
      if (gx >= 0 && gx < GW && gy >= 0 && gy < GH) {
        total += blurred[gy * GW + gx];
        count++;
      }
    }
    edgeScores[ei] = count > 0 ? total / count : 0;
  }

  // Flag bottom STRAGGLER_FRACTION as stragglers
  const sorted = Float32Array.from(edgeScores).sort();
  const threshold = sorted[Math.floor(ne * STRAGGLER_FRACTION)] || 0;
  const isStraggler = new Uint8Array(ne);
  for (let ei = 0; ei < ne; ei++) {
    if (edgeScores[ei] <= threshold) isStraggler[ei] = 1;
  }

  // Compute gradient for pre-pass (boundary-aware divisor)
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const xl = Math.max(0, x - 1);
      const xr = Math.min(GW - 1, x + 1);
      const yt = Math.max(0, y - 1);
      const yb = Math.min(GH - 1, y + 1);
      const divX = (xr - xl) || 1;  // 2 for interior cells, 1 for boundary
      const divY = (yb - yt) || 1;
      gradX[y * GW + x] = (blurred[y * GW + xr] - blurred[y * GW + xl]) / divX;
      gradY[y * GW + x] = (blurred[yb * GW + x] - blurred[yt * GW + x]) / divY;
    }
  }

  // 2 pre-iterations: advect only straggler edges with 3x step
  const preStep = stepStart * 3;
  for (let preIter = 0; preIter < 2; preIter++) {
    for (let ei = 0; ei < ne; ei++) {
      if (!isStraggler[ei]) continue;
      const base = ei * SAMPLES * 2;
      for (let pi = 1; pi < SAMPLES - 1; pi++) {
        const idx = base + pi * 2;
        const gx = Math.floor((pts[idx] - minX) / GRID_RES) | 0;
        const gy = Math.floor((pts[idx + 1] - minY) / GRID_RES) | 0;
        if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) continue;

        const dx = gradX[gy * GW + gx];
        const dy = gradY[gy * GW + gx];
        const mag = Math.sqrt(dx * dx + dy * dy);
        if (mag < 1e-9) continue;

        pts[idx] += preStep * dx / mag;
        pts[idx + 1] += preStep * dy / mag;
      }
    }

    // Pin endpoints after each pre-iteration
    for (let ei = 0; ei < ne; ei++) {
      if (!isStraggler[ei]) continue;
      const e = dataEdges[ei];
      const s = nodes[e.source];
      const t = nodes[e.target];
      const base = ei * SAMPLES * 2;
      pts[base] = s.x; pts[base + 1] = s.y;
      pts[base + (SAMPLES - 1) * 2] = t.x;
      pts[base + (SAMPLES - 1) * 2 + 1] = t.y;
    }
  }
}

/**
 * Run KDEEB and return bundled polylines per edge.
 * Output format: { x, y }[][] — one polyline per edge, drop-in for FDEB.
 */
export function kdeebBundle(
  nodes: Record<string, KdeebNode>,
  edges: KdeebEdge[],
  opts: KdeebOptions = {},
): { paths: Pt[][]; backend: 'cpu' } {
  const SAMPLES = opts.samples ?? 64;
  const iterations = opts.iterations ?? 8;
  const gradientTau = opts.gradientTau ?? 0.06;
  const pinZone = opts.pinZone ?? 0.18;

  // ── Filter self-loops, track original indices, compute bbox ──

  const { dataEdges, origIndices, bbox } = prepareBundleInput(nodes, edges);
  const { minX, minY, bboxW, bboxH, worldExtent } = bbox;

  const straightResult = (): { paths: Pt[][]; backend: 'cpu' } => ({
    paths: edges.map(e => {
      const s = nodes[e.source];
      const t = nodes[e.target];
      return s && t ? [{ x: s.x, y: s.y }, { x: t.x, y: t.y }] : [];
    }),
    backend: 'cpu',
  });

  if (dataEdges.length === 0) return straightResult();

  const ne = dataEdges.length;

  // ── Auto-scale parameters to world extent ──
  // Reference: worldExtent≈1000, gridRes=2, sigma=16→4, step=6→1.5

  const GRID_RES = worldExtent * 0.002;
  const GW = Math.ceil(bboxW / GRID_RES) + 1;
  const GH = Math.ceil(bboxH / GRID_RES) + 1;
  const sigmaStart = worldExtent * 0.024;
  const sigmaEnd = worldExtent * 0.004;
  const stepStart = worldExtent * 0.009;
  const stepEnd = worldExtent * 0.0015;

  // Pre-allocate blur kernel at max radius (avoids per-iteration allocation)
  const maxBlurSigma = sigmaStart / GRID_RES;
  const maxRadius = Math.ceil(maxBlurSigma * 3);
  const maxKSize = maxRadius * 2 + 1;
  const kernel = new Float32Array(maxKSize);

  // ── Allocate points: pts[e * SAMPLES + s] = (x, y) ──
  // Flat Float32Array: [x0, y0, x1, y1, ...]

  let pts = new Float32Array(ne * SAMPLES * 2);

  // Initialize as straight lines
  for (let ei = 0; ei < ne; ei++) {
    const e = dataEdges[ei];
    const s = nodes[e.source];
    const t = nodes[e.target];
    const base = ei * SAMPLES * 2;
    for (let pi = 0; pi < SAMPLES; pi++) {
      const frac = pi / (SAMPLES - 1);
      pts[base + pi * 2] = s.x + (t.x - s.x) * frac;
      pts[base + pi * 2 + 1] = s.y + (t.y - s.y) * frac;
    }
  }

  // ── Allocate grids ──

  const gridSize = GW * GH;
  const density = new Float32Array(gridSize);
  const blurred = new Float32Array(gridSize);
  const blurTmp = new Float32Array(gridSize);
  const gradX = new Float32Array(gridSize);
  const gradY = new Float32Array(gridSize);

  // ── Scratch for smoothing ──
  const smoothBuf = new Float32Array(ne * SAMPLES * 2);

  // ── Straggler detection and pre-advancement ──
  detectAndPreAdvanceStragglers(
    pts, dataEdges, nodes, ne, SAMPLES,
    minX, minY, GRID_RES, GW, GH,
    sigmaStart, stepStart,
    density, blurred, blurTmp, gradX, gradY,
  );

  // ── Main iteration loop ──

  for (let iter = 0; iter < iterations; iter++) {
    const frac = iter / Math.max(iterations - 1, 1);
    const sigma = sigmaStart * (1 - frac) + sigmaEnd * frac;
    const step = stepStart * (1 - frac) + stepEnd * frac;
    const blurSigma = sigma / GRID_RES; // sigma in grid-cell units

    // ── 1. Clear + splat density (nearest-cell, matches reference int() truncation) ──
    density.fill(0);
    for (let ei = 0; ei < ne; ei++) {
      const base = ei * SAMPLES * 2;
      // Only splat interior points (skip endpoints at index 0 and SAMPLES-1)
      for (let pi = 1; pi < SAMPLES - 1; pi++) {
        const px = pts[base + pi * 2];
        const py = pts[base + pi * 2 + 1];
        const gx = Math.floor((px - minX) / GRID_RES) | 0;
        const gy = Math.floor((py - minY) / GRID_RES) | 0;
        if (gx >= 0 && gx < GW && gy >= 0 && gy < GH) {
          density[gy * GW + gx] += 1.0;
        }
      }
    }

    // ── 2. Gaussian blur (separable, variable sigma) ──
    const radius = Math.ceil(blurSigma * 3);
    const kSize = radius * 2 + 1;
    kernel.fill(0);  // reuse pre-allocated kernel
    let kSum = 0;
    for (let i = 0; i < kSize; i++) {
      const d = i - radius;
      kernel[i] = Math.exp(-0.5 * (d * d) / (blurSigma * blurSigma));
      kSum += kernel[i];
    }
    for (let i = 0; i < kSize; i++) kernel[i] /= kSum;

    // Horizontal: density → blurTmp
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = Math.max(0, Math.min(GW - 1, x + k));
          sum += density[y * GW + sx] * kernel[k + radius];
        }
        blurTmp[y * GW + x] = sum;
      }
    }

    // Vertical: blurTmp → blurred
    for (let x = 0; x < GW; x++) {
      for (let y = 0; y < GH; y++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const sy = Math.max(0, Math.min(GH - 1, y + k));
          sum += blurTmp[sy * GW + x] * kernel[k + radius];
        }
        blurred[y * GW + x] = sum;
      }
    }

    // ── 3. Gradient via central finite differences (matches np.gradient) ──
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        const xl = Math.max(0, x - 1);
        const xr = Math.min(GW - 1, x + 1);
        const yt = Math.max(0, y - 1);
        const yb = Math.min(GH - 1, y + 1);
        const divX = (xr - xl) || 1;  // 2 for interior cells, 1 for boundary
        const divY = (yb - yt) || 1;
        gradX[y * GW + x] = (blurred[y * GW + xr] - blurred[y * GW + xl]) / divX;
        gradY[y * GW + x] = (blurred[yb * GW + x] - blurred[yt * GW + x]) / divY;
      }
    }

    // ── 4. Advect interior points ──
    for (let ei = 0; ei < ne; ei++) {
      const base = ei * SAMPLES * 2;
      for (let pi = 1; pi < SAMPLES - 1; pi++) {
        const idx = base + pi * 2;
        const px = pts[idx];
        const py = pts[idx + 1];

        const gx = Math.floor((px - minX) / GRID_RES) | 0;
        const gy = Math.floor((py - minY) / GRID_RES) | 0;
        if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) continue;

        const dx = gradX[gy * GW + gx];
        const dy = gradY[gy * GW + gx];
        const mag = Math.sqrt(dx * dx + dy * dy);
        if (mag < 1e-9) continue;

        const magScale = mag / (mag + gradientTau);
        const localStep = step * magScale;
        if (localStep <= 0) continue;

        pts[idx] += localStep * dx / mag;
        pts[idx + 1] += localStep * dy / mag;
      }
    }

    // ── 5. Smooth: 0.5·center + 0.25·(left + right) ──
    smoothBuf.set(pts);
    for (let ei = 0; ei < ne; ei++) {
      const base = ei * SAMPLES * 2;
      for (let pi = 1; pi < SAMPLES - 1; pi++) {
        const idx = base + pi * 2;
        const li = base + (pi - 1) * 2;
        const ri = base + (pi + 1) * 2;
        pts[idx] = 0.5 * smoothBuf[idx] + 0.25 * (smoothBuf[li] + smoothBuf[ri]);
        pts[idx + 1] = 0.5 * smoothBuf[idx + 1] + 0.25 * (smoothBuf[li + 1] + smoothBuf[ri + 1]);
      }
    }

    // ── 5b. Endpoint re-linearization ──
    for (let ei = 0; ei < ne; ei++) {
      const e = dataEdges[ei];
      const s = nodes[e.source];
      const t = nodes[e.target];
      const base = ei * SAMPLES * 2;

      const anchorLo = Math.ceil(pinZone * (SAMPLES - 1));
      const anchorHi = SAMPLES - 1 - anchorLo;

      const aLoX = pts[base + anchorLo * 2];
      const aLoY = pts[base + anchorLo * 2 + 1];
      const aHiX = pts[base + anchorHi * 2];
      const aHiY = pts[base + anchorHi * 2 + 1];

      for (let pi = 1; pi < SAMPLES - 1; pi++) {
        const tEdge = pi / (SAMPLES - 1);
        const idx = base + pi * 2;

        if (tEdge < pinZone) {
          const localT = tEdge / pinZone;
          const blend = localT * localT * (3 - 2 * localT);
          const straightX = s.x + localT * (aLoX - s.x);
          const straightY = s.y + localT * (aLoY - s.y);
          pts[idx] = straightX + blend * (pts[idx] - straightX);
          pts[idx + 1] = straightY + blend * (pts[idx + 1] - straightY);
        } else if (tEdge > 1 - pinZone) {
          const localT = (1 - tEdge) / pinZone;
          const blend = localT * localT * (3 - 2 * localT);
          const straightX = t.x + localT * (aHiX - t.x);
          const straightY = t.y + localT * (aHiY - t.y);
          pts[idx] = straightX + blend * (pts[idx] - straightX);
          pts[idx + 1] = straightY + blend * (pts[idx + 1] - straightY);
        }
      }
    }

    // ── 6. Pin endpoints ──
    for (let ei = 0; ei < ne; ei++) {
      const e = dataEdges[ei];
      const s = nodes[e.source];
      const t = nodes[e.target];
      const base = ei * SAMPLES * 2;
      pts[base] = s.x;
      pts[base + 1] = s.y;
      pts[base + (SAMPLES - 1) * 2] = t.x;
      pts[base + (SAMPLES - 1) * 2 + 1] = t.y;
    }

    // ── 7. Arc-length resample ──
    if (iter < iterations - 2) {
      pts = resample(pts, ne, SAMPLES);
    }
  }

  // ── Map results back to original edge indices ──

  const result: Pt[][] = edges.map(e => {
    const s = nodes[e.source];
    const t = nodes[e.target];
    return s && t ? [{ x: s.x, y: s.y }, { x: t.x, y: t.y }] : [];
  });

  for (let fi = 0; fi < ne; fi++) {
    const base = fi * SAMPLES * 2;
    const polyline: Pt[] = [];
    for (let pi = 0; pi < SAMPLES; pi++) {
      polyline.push({ x: pts[base + pi * 2], y: pts[base + pi * 2 + 1] });
    }
    result[origIndices[fi]] = polyline;
  }

  return { paths: result, backend: 'cpu' };
}

// ── Arc-length resample (vectorized across edges, matches reference) ──────────

function resample(pts: Float32Array, ne: number, samples: number): Float32Array {
  const out = new Float32Array(ne * samples * 2);

  for (let ei = 0; ei < ne; ei++) {
    const base = ei * samples * 2;

    // Compute segment lengths
    const segLens = new Float32Array(samples - 1);
    for (let s = 0; s < samples - 1; s++) {
      const dx = pts[base + (s + 1) * 2] - pts[base + s * 2];
      const dy = pts[base + (s + 1) * 2 + 1] - pts[base + s * 2 + 1];
      segLens[s] = Math.sqrt(dx * dx + dy * dy);
    }

    // Cumulative arc length
    const cumLen = new Float32Array(samples);
    for (let s = 1; s < samples; s++) {
      cumLen[s] = cumLen[s - 1] + segLens[s - 1];
    }
    const totalLen = cumLen[samples - 1];

    if (totalLen < 1e-6) {
      // Degenerate — copy as-is
      out.set(pts.subarray(base, base + samples * 2), base);
      continue;
    }

    // Resample at evenly-spaced arc lengths
    for (let k = 0; k < samples; k++) {
      const target = (k / (samples - 1)) * totalLen;

      // Binary search for the segment containing this target
      let lo = 0, hi = samples - 2;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cumLen[mid] <= target) lo = mid;
        else hi = mid - 1;
      }

      const segStart = cumLen[lo];
      const segL = segLens[lo];
      const t = segL > 1e-9 ? (target - segStart) / segL : 0;

      const p0x = pts[base + lo * 2];
      const p0y = pts[base + lo * 2 + 1];
      const p1x = pts[base + (lo + 1) * 2];
      const p1y = pts[base + (lo + 1) * 2 + 1];

      out[base + k * 2] = p0x + t * (p1x - p0x);
      out[base + k * 2 + 1] = p0y + t * (p1y - p0y);
    }

    // Enforce exact endpoints
    out[base] = pts[base];
    out[base + 1] = pts[base + 1];
    out[base + (samples - 1) * 2] = pts[base + (samples - 1) * 2];
    out[base + (samples - 1) * 2 + 1] = pts[base + (samples - 1) * 2 + 1];
  }

  return out;
}
