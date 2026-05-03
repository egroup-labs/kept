/**
 * kdeeb-gpu.ts — Kernel Density Estimation Edge Bundling (WebGPU).
 *
 * Matches the reference KDEEB algorithm:
 *   1. clear_density   — zero the atomic u32 grid
 *   2. splat_points    — nearest-cell scatter into density grid
 *   3. convert_density — u32 → f32
 *   4. blur_x / blur_y — separable Gaussian blur (variable sigma per iter)
 *   5. compute_gradient — central finite differences
 *   6. advect_points   — normalized gradient with endpoint/weak-field damping
 *   7. smooth_points   — 0.5·center + 0.25·(left + right)
 *   8. resample_points — arc-length resample (workgroup prefix sum)
 *
 * All WGSL shaders embedded as string literals.
 */

import type { KdeebNode, KdeebEdge, KdeebOptions } from './kdeeb';

interface Pt { x: number; y: number }

// ── WGSL Shaders ─────────────────────────────────────────────────────────────

const PARAMS_STRUCT_WGSL = 'struct Params { GW: u32, GH: u32, totalPts: u32, step: f32, minX: f32, minY: f32, gridRes: f32, samples: u32, gradTau: f32, dampWidth: f32, splatLo: u32, splatHi: u32, numBins: u32, perpBias: f32, adaptiveOn: u32, _pad: u32 }';

const CLEAR_DENSITY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> density: array<atomic<u32>>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.GW * params.GH) { return; }
  atomicStore(&density[idx], 0u);
}
`;

const SPLAT_POINTS_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> density: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> positions: array<f32>;
@group(0) @binding(8) var<storage, read> endpointFlags: array<u32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let ptIdx = gid.x;
  if (ptIdx >= params.totalPts) { return; }
  // Only splat interior points
  if (endpointFlags[ptIdx] == 1u) { return; }

  // Skip points in the endpoint zone (splat skip zone)
  let localIdx = ptIdx % params.samples;
  if (localIdx < params.splatLo || localIdx >= params.splatHi) { return; }

  let wx = positions[ptIdx * 2u];
  let wy = positions[ptIdx * 2u + 1u];

  let gx = i32(floor((wx - params.minX) / params.gridRes));
  let gy = i32(floor((wy - params.minY) / params.gridRes));

  if (gx >= 0 && u32(gx) < params.GW && gy >= 0 && u32(gy) < params.GH) {
    atomicAdd(&density[u32(gy) * params.GW + u32(gx)], 1000u);
  }
}
`;

const CONVERT_DENSITY_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> densityU: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> densityF: array<f32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.GW * params.GH) { return; }
  densityF[idx] = f32(atomicLoad(&densityU[idx])) / 1000.0;
}
`;

const BLUR_X_WGSL = /* wgsl */ `
@group(0) @binding(3) var<storage, read> input: array<f32>;
@group(0) @binding(4) var<storage, read_write> output: array<f32>;
@group(0) @binding(5) var<storage, read> kern: array<f32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

struct BlurParams { radius: i32 }
@group(0) @binding(6) var<uniform> blurParams: BlurParams;

const TILE_W: u32 = 128u;
const MAX_R: u32 = 60u;
var<workgroup> tile: array<f32, 248u>;  // TILE_W + 2 * MAX_R

@compute @workgroup_size(128, 1)
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wg: vec3u,
) {
  // Use workgroup_id.y (uniform) instead of global_invocation_id.y
  // With workgroup_size(128,1), wg.y == gid.y but wg.y is uniform across the workgroup
  let y = wg.y;
  if (y >= params.GH) { return; }

  let lx = lid.x;
  let globalX = wg.x * TILE_W + lx;
  let r = u32(blurParams.radius);

  // Load center element into shared memory
  if (globalX < params.GW) {
    tile[lx + r] = input[y * params.GW + globalX];
  } else {
    tile[lx + r] = 0.0;
  }

  // Load left halo (first r threads)
  if (lx < r) {
    let haloX = clamp(i32(wg.x * TILE_W) - i32(r) + i32(lx), 0, i32(params.GW) - 1);
    tile[lx] = input[y * params.GW + u32(haloX)];
  }

  // Load right halo (last r threads)
  if (lx >= TILE_W - r) {
    let haloX = clamp(i32(wg.x * TILE_W) + i32(lx) + i32(r), 0, i32(params.GW) - 1);
    tile[lx + 2u * r] = input[y * params.GW + u32(haloX)];
  }

  workgroupBarrier();

  if (globalX >= params.GW) { return; }

  // Convolve from shared memory
  var sum = 0.0;
  let kSize = 2u * r + 1u;
  for (var k = 0u; k < kSize; k++) {
    sum += tile[lx + k] * kern[k];
  }
  output[y * params.GW + globalX] = sum;
}
`;

const BLUR_Y_WGSL = /* wgsl */ `
@group(0) @binding(4) var<storage, read> input: array<f32>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;
@group(0) @binding(5) var<storage, read> kern: array<f32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

struct BlurParams { radius: i32 }
@group(0) @binding(6) var<uniform> blurParams: BlurParams;

const TILE_H: u32 = 128u;
const MAX_R: u32 = 60u;
var<workgroup> col: array<f32, 248u>;  // TILE_H + 2 * MAX_R

@compute @workgroup_size(1, 128)
fn main(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(workgroup_id) wg: vec3u,
) {
  // Use workgroup_id.x (uniform) instead of global_invocation_id.x
  // With workgroup_size(1,128), wg.x == gid.x but wg.x is uniform across the workgroup
  let x = wg.x;
  if (x >= params.GW) { return; }

  let ly = lid.y;
  let globalY = wg.y * TILE_H + ly;
  let r = u32(blurParams.radius);

  // Load center element
  if (globalY < params.GH) {
    col[ly + r] = input[globalY * params.GW + x];
  } else {
    col[ly + r] = 0.0;
  }

  // Load top halo (first r threads)
  if (ly < r) {
    let haloY = clamp(i32(wg.y * TILE_H) - i32(r) + i32(ly), 0, i32(params.GH) - 1);
    col[ly] = input[u32(haloY) * params.GW + x];
  }

  // Load bottom halo (last r threads)
  if (ly >= TILE_H - r) {
    let haloY = clamp(i32(wg.y * TILE_H) + i32(ly) + i32(r), 0, i32(params.GH) - 1);
    col[ly + 2u * r] = input[u32(haloY) * params.GW + x];
  }

  workgroupBarrier();

  if (globalY >= params.GH) { return; }

  // Convolve from shared memory
  var sum = 0.0;
  let kSize = 2u * r + 1u;
  for (var k = 0u; k < kSize; k++) {
    sum += col[ly + k] * kern[k];
  }
  output[globalY * params.GW + x] = sum;
}
`;

const COMPUTE_GRADIENT_WGSL = /* wgsl */ `
@group(0) @binding(3) var<storage, read> density: array<f32>;
@group(0) @binding(7) var<storage, read_write> gradient: array<f32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let x = gid.x;
  let y = gid.y;
  if (x >= params.GW || y >= params.GH) { return; }

  let xl = max(i32(x) - 1, 0);
  let xr = min(i32(x) + 1, i32(params.GW) - 1);
  let yt = max(i32(y) - 1, 0);
  let yb = min(i32(y) + 1, i32(params.GH) - 1);

  let dx = (density[y * params.GW + u32(xr)] - density[y * params.GW + u32(xl)]) * 0.5;
  let dy = (density[u32(yb) * params.GW + x] - density[u32(yt) * params.GW + x]) * 0.5;

  let idx = (y * params.GW + x) * 2u;
  gradient[idx] = dx;
  gradient[idx + 1u] = dy;
}
`;

const ADVECT_POINTS_WGSL = /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> positions: array<f32>;
@group(0) @binding(7) var<storage, read> gradient: array<f32>;
@group(0) @binding(8) var<storage, read> endpointFlags: array<u32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let ptIdx = gid.x;
  if (ptIdx >= params.totalPts) { return; }
  if (endpointFlags[ptIdx] == 1u) { return; }

  let wx = positions[ptIdx * 2u];
  let wy = positions[ptIdx * 2u + 1u];

  let gx = i32(floor((wx - params.minX) / params.gridRes));
  let gy = i32(floor((wy - params.minY) / params.gridRes));
  if (gx < 0 || u32(gx) >= params.GW || gy < 0 || u32(gy) >= params.GH) { return; }

  let gIdx = (u32(gy) * params.GW + u32(gx)) * 2u;
  let dx = gradient[gIdx];
  let dy = gradient[gIdx + 1u];
  let mag = sqrt(dx * dx + dy * dy);
  if (mag < 1e-9) { return; }

  let magScale = mag / (mag + params.gradTau);
  let localStep = params.step * magScale;
  if (localStep <= 0.0) { return; }

  positions[ptIdx * 2u]     += localStep * dx / mag;
  positions[ptIdx * 2u + 1u] += localStep * dy / mag;
}
`;

const STRAGGLER_ADVECT_WGSL = /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> positions: array<f32>;
@group(0) @binding(7) var<storage, read> gradient: array<f32>;
@group(0) @binding(8) var<storage, read> endpointFlags: array<u32>;
@group(0) @binding(11) var<storage, read> stragglerFlags: array<u32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let ptIdx = gid.x;
  if (ptIdx >= params.totalPts) { return; }
  if (endpointFlags[ptIdx] == 1u) { return; }
  if (stragglerFlags[ptIdx] == 0u) { return; }

  let wx = positions[ptIdx * 2u];
  let wy = positions[ptIdx * 2u + 1u];

  let gx = i32(floor((wx - params.minX) / params.gridRes));
  let gy = i32(floor((wy - params.minY) / params.gridRes));
  if (gx < 0 || u32(gx) >= params.GW || gy < 0 || u32(gy) >= params.GH) { return; }

  let gIdx = (u32(gy) * params.GW + u32(gx)) * 2u;
  let dx = gradient[gIdx];
  let dy = gradient[gIdx + 1u];
  let mag = sqrt(dx * dx + dy * dy);
  if (mag < 1e-9) { return; }

  let boostedStep = params.step * 3.0;
  positions[ptIdx * 2u]     += boostedStep * dx / mag;
  positions[ptIdx * 2u + 1u] += boostedStep * dy / mag;
}
`;

// Smooth: 0.5·center + 0.25·(left + right) for interior points
const SMOOTH_POINTS_WGSL = /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> positions: array<f32>;
@group(0) @binding(9) var<storage, read_write> smoothBuf: array<f32>;
@group(0) @binding(8) var<storage, read> endpointFlags: array<u32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

// Pass 1: copy positions → smoothBuf
// Pass 2: smooth from smoothBuf → positions
// We handle both in one dispatch by using smoothBuf as scratch

@compute @workgroup_size(256)
fn copy_to_buf(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.totalPts * 2u) { return; }
  smoothBuf[idx] = positions[idx];
}

@compute @workgroup_size(256)
fn smooth_apply(@builtin(global_invocation_id) gid: vec3u) {
  let ptIdx = gid.x;
  if (ptIdx >= params.totalPts) { return; }
  if (endpointFlags[ptIdx] == 1u) { return; }

  // Check if this is an interior point (not first or last in its edge)
  let edgeLocalIdx = ptIdx % params.samples;
  if (edgeLocalIdx == 0u || edgeLocalIdx == params.samples - 1u) { return; }

  let ci = ptIdx * 2u;
  let li = (ptIdx - 1u) * 2u;
  let ri = (ptIdx + 1u) * 2u;

  positions[ci]     = 0.5 * smoothBuf[ci]     + 0.25 * (smoothBuf[li]     + smoothBuf[ri]);
  positions[ci + 1u] = 0.5 * smoothBuf[ci + 1u] + 0.25 * (smoothBuf[li + 1u] + smoothBuf[ri + 1u]);
}
`;

// Re-linearize endpoint zones — blend back toward straight line from endpoint to anchor
const RELINEARIZE_WGSL = /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> positions: array<f32>;
@group(0) @binding(8) var<storage, read> endpointFlags: array<u32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let ptIdx = gid.x;
  if (ptIdx >= params.totalPts) { return; }
  if (endpointFlags[ptIdx] == 1u) { return; }

  let samples = params.samples;
  let edgeIdx = ptIdx / samples;
  let localIdx = ptIdx % samples;
  if (localIdx == 0u || localIdx == samples - 1u) { return; }

  let pinZone = params.dampWidth;  // repurposed as pinZone (0.18)
  let tEdge = f32(localIdx) / f32(samples - 1u);

  if (tEdge >= pinZone && tEdge <= 1.0 - pinZone) { return; }

  let base = edgeIdx * samples;

  let srcX = positions[base * 2u];
  let srcY = positions[base * 2u + 1u];
  let tgtX = positions[(base + samples - 1u) * 2u];
  let tgtY = positions[(base + samples - 1u) * 2u + 1u];

  let anchorLo = u32(ceil(pinZone * f32(samples - 1u)));
  let anchorHi = samples - 1u - anchorLo;

  let px = positions[ptIdx * 2u];
  let py = positions[ptIdx * 2u + 1u];

  if (tEdge < pinZone) {
    let aX = positions[(base + anchorLo) * 2u];
    let aY = positions[(base + anchorLo) * 2u + 1u];
    let localT = tEdge / pinZone;
    let blend = localT * localT * (3.0 - 2.0 * localT);
    let sX = srcX + localT * (aX - srcX);
    let sY = srcY + localT * (aY - srcY);
    positions[ptIdx * 2u]     = sX + blend * (px - sX);
    positions[ptIdx * 2u + 1u] = sY + blend * (py - sY);
  } else {
    let aX = positions[(base + anchorHi) * 2u];
    let aY = positions[(base + anchorHi) * 2u + 1u];
    let localT = (1.0 - tEdge) / pinZone;
    let blend = localT * localT * (3.0 - 2.0 * localT);
    let sX = tgtX + localT * (aX - tgtX);
    let sY = tgtY + localT * (aY - tgtY);
    positions[ptIdx * 2u]     = sX + blend * (px - sX);
    positions[ptIdx * 2u + 1u] = sY + blend * (py - sY);
  }
}
`;

// Arc-length resample — one workgroup per edge, thread 0 does prefix sum
const RESAMPLE_POINTS_WGSL = /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> positions: array<f32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

struct ResampleParams { numEdges: u32 }
@group(0) @binding(10) var<uniform> resampleParams: ResampleParams;

var<workgroup> old_x: array<f32, 64>;
var<workgroup> old_y: array<f32, 64>;
var<workgroup> seg_lens: array<f32, 64>;
var<workgroup> cum_lens: array<f32, 65>;

@compute @workgroup_size(64)
fn main(
  @builtin(workgroup_id) wg: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
) {
  let edge = wg.x;
  let s = lid.x;
  let samples = params.samples;
  let is_active = (edge < resampleParams.numEdges) && (s < samples);
  let base = edge * samples;

  // Load positions into shared memory (all 64 threads participate)
  if (is_active) {
    old_x[s] = positions[(base + s) * 2u];
    old_y[s] = positions[(base + s) * 2u + 1u];
  }
  workgroupBarrier();

  // Compute segment lengths
  if (is_active && s < samples - 1u) {
    let dx = old_x[s + 1u] - old_x[s];
    let dy = old_y[s + 1u] - old_y[s];
    seg_lens[s] = sqrt(dx * dx + dy * dy);
  } else if (is_active) {
    seg_lens[s] = 0.0;
  }
  workgroupBarrier();

  // Thread 0: sequential prefix sum (only 63 additions)
  if (s == 0u && is_active) {
    cum_lens[0] = 0.0;
    for (var i = 0u; i < samples - 1u; i++) {
      cum_lens[i + 1u] = cum_lens[i] + seg_lens[i];
    }
  }
  workgroupBarrier();

  if (!is_active) { return; }

  let total = cum_lens[samples - 1u];
  if (total < 1e-6) { return; }

  // Each thread resamples its point
  let tgt_len = f32(s) / f32(samples - 1u) * total;

  // Binary search for the segment
  var lo = 0u;
  var hi = samples - 2u;
  while (lo < hi) {
    let mid = (lo + hi + 1u) / 2u;
    if (cum_lens[mid] <= tgt_len) { lo = mid; } else { hi = mid - 1u; }
  }

  let seg_start = cum_lens[lo];
  let seg_l = seg_lens[lo];
  let t = select(0.0, (tgt_len - seg_start) / seg_l, seg_l > 1e-9);

  var new_x = old_x[lo] + t * (old_x[lo + 1u] - old_x[lo]);
  var new_y = old_y[lo] + t * (old_y[lo + 1u] - old_y[lo]);

  // Pin endpoints
  if (s == 0u) { new_x = old_x[0]; new_y = old_y[0]; }
  if (s == samples - 1u) { new_x = old_x[samples - 1u]; new_y = old_y[samples - 1u]; }

  positions[(base + s) * 2u] = new_x;
  positions[(base + s) * 2u + 1u] = new_y;
}
`;

// ── Directional KDEEB shaders ────────────────────────────────────────────────

const CLEAR_DIR_DENSITY_WGSL = /* wgsl */ `
@group(0) @binding(12) var<storage, read_write> dirDensity: array<atomic<u32>>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.numBins * params.GW * params.GH) { return; }
  atomicStore(&dirDensity[idx], 0u);
}
`;

const SPLAT_DIRECTIONAL_WGSL = /* wgsl */ `
@group(0) @binding(12) var<storage, read_write> dirDensity: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> positions: array<f32>;
@group(0) @binding(8) var<storage, read> endpointFlags: array<u32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

const PI: f32 = 3.14159265;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let ptIdx = gid.x;
  if (ptIdx >= params.totalPts) { return; }
  if (endpointFlags[ptIdx] == 1u) { return; }

  let localIdx = ptIdx % params.samples;
  if (localIdx < params.splatLo || localIdx >= params.splatHi) { return; }

  let wx = positions[ptIdx * 2u];
  let wy = positions[ptIdx * 2u + 1u];

  let gx = i32(floor((wx - params.minX) / params.gridRes));
  let gy = i32(floor((wy - params.minY) / params.gridRes));
  if (gx < 0 || u32(gx) >= params.GW || gy < 0 || u32(gy) >= params.GH) { return; }

  // Compute local tangent via central difference (prev → next), clamped to edge
  let edgeBase = (ptIdx / params.samples) * params.samples;
  let safeP = max(edgeBase, ptIdx - 1u);
  let safeN = min(edgeBase + params.samples - 1u, ptIdx + 1u);
  let tx = positions[safeN * 2u] - positions[safeP * 2u];
  let ty = positions[safeN * 2u + 1u] - positions[safeP * 2u + 1u];

  // Angle in [0, pi) — direction-symmetric
  var angle = atan2(ty, tx);
  if (angle < 0.0) { angle += PI; }
  if (angle >= PI) { angle -= PI; }

  let bin = clamp(u32(angle / PI * f32(params.numBins)), 0u, params.numBins - 1u);
  let gridCells = params.GW * params.GH;
  let cellIdx = bin * gridCells + u32(gy) * params.GW + u32(gx);
  atomicAdd(&dirDensity[cellIdx], 1000u);
}
`;

const CONVERT_DIR_DENSITY_WGSL = /* wgsl */ `
@group(0) @binding(12) var<storage, read_write> dirDensityU: array<atomic<u32>>;
@group(0) @binding(13) var<storage, read_write> dirDensityF: array<f32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.numBins * params.GW * params.GH) { return; }
  dirDensityF[idx] = f32(atomicLoad(&dirDensityU[idx])) / 1000.0;
}
`;

const SUM_DIR_BINS_WGSL = /* wgsl */ `
@group(0) @binding(13) var<storage, read> dirDensityF: array<f32>;
@group(0) @binding(3) var<storage, read_write> densityF: array<f32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  let gridCells = params.GW * params.GH;
  if (idx >= gridCells) { return; }

  var total = 0.0;
  for (var b = 0u; b < params.numBins; b++) {
    total += dirDensityF[b * gridCells + idx];
  }
  densityF[idx] = total;
}
`;

const MAX_DENSITY_WGSL = /* wgsl */ `
@group(0) @binding(3) var<storage, read> densityF: array<f32>;
@group(0) @binding(15) var<storage, read_write> maxDensity: array<atomic<u32>>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

@compute @workgroup_size(256)
fn clear(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x == 0u) {
    atomicStore(&maxDensity[0], 0u);
  }
}

@compute @workgroup_size(256)
fn reduce(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.GW * params.GH) { return; }
  let val = densityF[idx];
  if (val > 0.0) {
    // bitcast float→u32 works for atomicMax on non-negative IEEE 754 floats
    atomicMax(&maxDensity[0], bitcast<u32>(val));
  }
}
`;

const ADVECT_DIRECTIONAL_WGSL = /* wgsl */ `
@group(0) @binding(2) var<storage, read_write> positions: array<f32>;
@group(0) @binding(14) var<storage, read> dirGradient: array<f32>;
@group(0) @binding(8) var<storage, read> endpointFlags: array<u32>;
@group(0) @binding(3) var<storage, read> densityF: array<f32>;
@group(0) @binding(15) var<storage, read> maxDensity: array<u32>;

${PARAMS_STRUCT_WGSL}
@group(0) @binding(1) var<uniform> params: Params;

const PI: f32 = 3.14159265;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let ptIdx = gid.x;
  if (ptIdx >= params.totalPts) { return; }
  if (endpointFlags[ptIdx] == 1u) { return; }

  let localIdx = ptIdx % params.samples;
  if (localIdx == 0u || localIdx == params.samples - 1u) { return; }

  let wx = positions[ptIdx * 2u];
  let wy = positions[ptIdx * 2u + 1u];

  let gx = i32(floor((wx - params.minX) / params.gridRes));
  let gy = i32(floor((wy - params.minY) / params.gridRes));
  if (gx < 0 || u32(gx) >= params.GW || gy < 0 || u32(gy) >= params.GH) { return; }

  let gridCells = params.GW * params.GH;
  let cellIdx = u32(gy) * params.GW + u32(gx);

  // Compute tangent via central difference, clamped to edge
  let edgeBase = (ptIdx / params.samples) * params.samples;
  let safeP = max(edgeBase, ptIdx - 1u);
  let safeN = min(edgeBase + params.samples - 1u, ptIdx + 1u);
  let rawTx = positions[safeN * 2u] - positions[safeP * 2u];
  let rawTy = positions[safeN * 2u + 1u] - positions[safeP * 2u + 1u];
  let tMag = sqrt(rawTx * rawTx + rawTy * rawTy);
  let tnx = select(rawTx / tMag, 0.0, tMag < 1e-9);
  let tny = select(rawTy / tMag, 0.0, tMag < 1e-9);

  // Determine primary bin from tangent angle
  var angle = atan2(rawTy, rawTx);
  if (angle < 0.0) { angle += PI; }
  if (angle >= PI) { angle -= PI; }
  let b0 = clamp(u32(angle / PI * f32(params.numBins)), 0u, params.numBins - 1u);
  let bPrev = select(b0 - 1u, params.numBins - 1u, b0 == 0u);
  let bNext = select(b0 + 1u, 0u, b0 == params.numBins - 1u);

  // Blend gradient from primary + neighbor bins (0.6 / 0.2 / 0.2)
  let g0 = b0 * gridCells * 2u + cellIdx * 2u;
  let gP = bPrev * gridCells * 2u + cellIdx * 2u;
  let gN = bNext * gridCells * 2u + cellIdx * 2u;

  var dx = 0.6 * dirGradient[g0] + 0.2 * dirGradient[gP] + 0.2 * dirGradient[gN];
  var dy = 0.6 * dirGradient[g0 + 1u] + 0.2 * dirGradient[gP + 1u] + 0.2 * dirGradient[gN + 1u];

  // Perpendicular bias: project out tangent component
  if (params.perpBias > 0.0) {
    let dot_val = dx * tnx + dy * tny;
    let perpDx = dx - dot_val * tnx;
    let perpDy = dy - dot_val * tny;
    dx = (1.0 - params.perpBias) * dx + params.perpBias * perpDx;
    dy = (1.0 - params.perpBias) * dy + params.perpBias * perpDy;
  }

  let mag = sqrt(dx * dx + dy * dy);
  if (mag < 1e-9) { return; }

  let magScale = mag / (mag + params.gradTau);
  var localStep = params.step * magScale;

  // Adaptive: scale step by inverse local density
  if (params.adaptiveOn == 1u) {
    let d = densityF[cellIdx];
    let dMaxU = maxDensity[0];
    let dMax = select(bitcast<f32>(dMaxU), 1.0, dMaxU == 0u);
    let adaptScale = 2.0 - 1.7 * (d / dMax);
    localStep = localStep * adaptScale;
  }

  if (localStep <= 0.0) { return; }

  positions[ptIdx * 2u]     += localStep * dx / mag;
  positions[ptIdx * 2u + 1u] += localStep * dy / mag;
}
`;

// ── KdeebGpu class ───────────────────────────────────────────────────────────

export class KdeebGpu {
  private device: GPUDevice;
  private deviceLost = false;
  private clearPipeline: GPUComputePipeline;
  private splatPipeline: GPUComputePipeline;
  private convertPipeline: GPUComputePipeline;
  private blurXPipeline: GPUComputePipeline;
  private blurYPipeline: GPUComputePipeline;
  private gradientPipeline: GPUComputePipeline;
  private advectPipeline: GPUComputePipeline;
  private smoothCopyPipeline: GPUComputePipeline;
  private smoothPipeline: GPUComputePipeline;
  private relinearizePipeline: GPUComputePipeline;
  private resamplePipeline: GPUComputePipeline;
  private stragglerAdvectPipeline: GPUComputePipeline;
  // Directional KDEEB pipelines
  private dirClearPipeline: GPUComputePipeline;
  private dirSplatPipeline: GPUComputePipeline;
  private dirConvertPipeline: GPUComputePipeline;
  private sumDirBinsPipeline: GPUComputePipeline;
  private maxDensityClearPipeline: GPUComputePipeline;
  private maxDensityReducePipeline: GPUComputePipeline;
  private advectDirectionalPipeline: GPUComputePipeline;

  private pool: {
    ne: number;
    totalPts: number;
    gridCells: number;
    numBins: number;
    GW: number;
    GH: number;
    buffers: {
      density: GPUBuffer;
      positions: GPUBuffer;
      densityF: GPUBuffer;
      blurTmp: GPUBuffer;
      gradient: GPUBuffer;
      endpointFlags: GPUBuffer;
      smoothBuf: GPUBuffer;
      staging: GPUBuffer;
      resampleParams: GPUBuffer;
      dirDensityU: GPUBuffer | null;
      dirDensityF: GPUBuffer | null;
      dirGradient: GPUBuffer | null;
      maxDensityBuf: GPUBuffer | null;
    };
  } | null = null;

  private constructor(
    device: GPUDevice,
    pipelines: {
      clear: GPUComputePipeline;
      splat: GPUComputePipeline;
      convert: GPUComputePipeline;
      blurX: GPUComputePipeline;
      blurY: GPUComputePipeline;
      gradient: GPUComputePipeline;
      advect: GPUComputePipeline;
      smoothCopy: GPUComputePipeline;
      smooth: GPUComputePipeline;
      relinearize: GPUComputePipeline;
      resample: GPUComputePipeline;
      stragglerAdvect: GPUComputePipeline;
      dirClear: GPUComputePipeline;
      dirSplat: GPUComputePipeline;
      dirConvert: GPUComputePipeline;
      sumDirBins: GPUComputePipeline;
      maxDensityClear: GPUComputePipeline;
      maxDensityReduce: GPUComputePipeline;
      advectDirectional: GPUComputePipeline;
    },
  ) {
    this.device = device;
    this.clearPipeline = pipelines.clear;
    this.splatPipeline = pipelines.splat;
    this.convertPipeline = pipelines.convert;
    this.blurXPipeline = pipelines.blurX;
    this.blurYPipeline = pipelines.blurY;
    this.gradientPipeline = pipelines.gradient;
    this.advectPipeline = pipelines.advect;
    this.smoothCopyPipeline = pipelines.smoothCopy;
    this.smoothPipeline = pipelines.smooth;
    this.relinearizePipeline = pipelines.relinearize;
    this.resamplePipeline = pipelines.resample;
    this.stragglerAdvectPipeline = pipelines.stragglerAdvect;
    this.dirClearPipeline = pipelines.dirClear;
    this.dirSplatPipeline = pipelines.dirSplat;
    this.dirConvertPipeline = pipelines.dirConvert;
    this.sumDirBinsPipeline = pipelines.sumDirBins;
    this.maxDensityClearPipeline = pipelines.maxDensityClear;
    this.maxDensityReducePipeline = pipelines.maxDensityReduce;
    this.advectDirectionalPipeline = pipelines.advectDirectional;
  }

  static async create(): Promise<KdeebGpu> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPU: no adapter');
    const device = await adapter.requestDevice();

    const makePipeline = (code: string, label: string, entry = 'main') => {
      const module = device.createShaderModule({ code, label });
      return device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: entry },
      });
    };

    const instance = new KdeebGpu(device, {
      clear: makePipeline(CLEAR_DENSITY_WGSL, 'clear_density'),
      splat: makePipeline(SPLAT_POINTS_WGSL, 'splat_points'),
      convert: makePipeline(CONVERT_DENSITY_WGSL, 'convert_density'),
      blurX: makePipeline(BLUR_X_WGSL, 'blur_x'),
      blurY: makePipeline(BLUR_Y_WGSL, 'blur_y'),
      gradient: makePipeline(COMPUTE_GRADIENT_WGSL, 'compute_gradient'),
      advect: makePipeline(ADVECT_POINTS_WGSL, 'advect_points'),
      smoothCopy: makePipeline(SMOOTH_POINTS_WGSL, 'smooth_copy', 'copy_to_buf'),
      smooth: makePipeline(SMOOTH_POINTS_WGSL, 'smooth_apply', 'smooth_apply'),
      relinearize: makePipeline(RELINEARIZE_WGSL, 'relinearize'),
      resample: makePipeline(RESAMPLE_POINTS_WGSL, 'resample_points'),
      stragglerAdvect: makePipeline(STRAGGLER_ADVECT_WGSL, 'straggler_advect'),
      dirClear: makePipeline(CLEAR_DIR_DENSITY_WGSL, 'dir_clear_density'),
      dirSplat: makePipeline(SPLAT_DIRECTIONAL_WGSL, 'dir_splat'),
      dirConvert: makePipeline(CONVERT_DIR_DENSITY_WGSL, 'dir_convert'),
      sumDirBins: makePipeline(SUM_DIR_BINS_WGSL, 'sum_dir_bins'),
      maxDensityClear: makePipeline(MAX_DENSITY_WGSL, 'max_density_clear', 'clear'),
      maxDensityReduce: makePipeline(MAX_DENSITY_WGSL, 'max_density_reduce', 'reduce'),
      advectDirectional: makePipeline(ADVECT_DIRECTIONAL_WGSL, 'advect_directional'),
    });
    device.lost.then(_info => { instance.deviceLost = true; });
    return instance;
  }

  destroy(): void {
    if (this.pool) {
      for (const buf of Object.values(this.pool.buffers)) {
        if (buf) (buf as GPUBuffer).destroy();
      }
      this.pool = null;
    }
    this.device.destroy();
  }

  async bundle(
    nodes: Record<string, KdeebNode>,
    edges: KdeebEdge[],
    opts: KdeebOptions = {},
  ): Promise<{ paths: Pt[][]; backend: 'webgpu' }> {
    if (this.deviceLost) throw new Error('GPU device lost');
    const SAMPLES = opts.samples ?? 64;
    if (SAMPLES !== 64) throw new Error('GPU resample requires samples=64');
    const iterations = opts.iterations ?? 20;
    const eps = 1e-6;
    const device = this.device;
    const numBins = opts.directionalBins ?? 4;
    const adaptiveAttraction = opts.adaptiveAttraction ?? true;
    const perpBias = opts.perpBias ?? 0.6;
    const splatSkipZone = opts.splatSkipZone ?? 0.22;
    const postSmoothIters = opts.postSmoothIters ?? 10;
    const stepStartFactor = opts.stepStartFactor ?? 0.012;

    // ── Filter self-loops ──
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

    if (dataEdges.length === 0) {
      return {
        paths: edges.map(e => {
          const s = nodes[e.source];
          const t = nodes[e.target];
          return s && t ? [{ x: s.x, y: s.y }, { x: t.x, y: t.y }] : [];
        }),
        backend: 'webgpu',
      };
    }

    const ne = dataEdges.length;
    const totalPts = ne * SAMPLES;

    // ── Bounding box + auto-scale params ──
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

    const GRID_RES = worldExtent * 0.002;
    const GW = Math.ceil(bboxW / GRID_RES) + 1;
    const GH = Math.ceil(bboxH / GRID_RES) + 1;
    const gridCells = GW * GH;
    const sigmaStart = worldExtent * 0.024;
    const sigmaEnd = worldExtent * 0.004;
    const stepStart = worldExtent * stepStartFactor;
    const stepEnd = worldExtent * 0.0015;
    const gradientTau = opts.gradientTau ?? 0.03;
    const endpointDampWidth = opts.pinZone ?? opts.endpointDampWidth ?? 0.22;

    // Splat skip zone: compute lo/hi sample indices
    let splatLo = 1;
    let splatHi = SAMPLES - 1;
    if (splatSkipZone > 0) {
      splatLo = Math.max(1, Math.ceil(splatSkipZone * (SAMPLES - 1)));
      splatHi = Math.min(SAMPLES - 1, SAMPLES - 1 - splatLo);
      if (splatLo >= splatHi) { splatLo = 1; splatHi = SAMPLES - 1; }
    }

    // ── Initialize positions + endpoint flags ──
    const positionsData = new Float32Array(totalPts * 2);
    const endpointFlagsData = new Uint32Array(totalPts);

    for (let ei = 0; ei < ne; ei++) {
      const e = dataEdges[ei];
      const s = nodes[e.source];
      const t = nodes[e.target];
      const base = ei * SAMPLES;
      for (let pi = 0; pi < SAMPLES; pi++) {
        const frac = pi / (SAMPLES - 1);
        positionsData[(base + pi) * 2] = s.x + (t.x - s.x) * frac;
        positionsData[(base + pi) * 2 + 1] = s.y + (t.y - s.y) * frac;
        if (pi === 0 || pi === SAMPLES - 1) endpointFlagsData[base + pi] = 1;
      }
    }

    // ── Create / reuse GPU buffers (pool) ──

    // Max kernel size (for sigma_start)
    const maxBlurSigma = sigmaStart / GRID_RES;
    const maxRadius = Math.min(60, Math.ceil(maxBlurSigma * 3));
    const maxKernelSize = maxRadius * 2 + 1;
    const kernelPadded = Math.ceil(maxKernelSize / 4) * 4;

    let densityBuffer: GPUBuffer;
    let positionsBuffer: GPUBuffer;
    let densityFBuffer: GPUBuffer;
    let blurTmpBuffer: GPUBuffer;
    let gradientBuffer: GPUBuffer;
    let endpointFlagsBuffer: GPUBuffer;
    let smoothBufBuffer: GPUBuffer;
    let stagingBuffer: GPUBuffer;
    let resampleParamsBuffer: GPUBuffer;
    let dirDensityUBuffer: GPUBuffer | null = null;
    let dirDensityFBuffer: GPUBuffer | null = null;
    let dirGradientBuffer: GPUBuffer | null = null;
    let maxDensityBufBuffer: GPUBuffer | null = null;

    const canReuse = this.pool &&
      this.pool.ne === ne &&
      this.pool.totalPts === totalPts &&
      this.pool.gridCells >= gridCells &&
      this.pool.numBins === numBins &&
      this.pool.GW === GW &&
      this.pool.GH === GH;

    if (canReuse) {
      // Reuse existing buffers
      const b = this.pool!.buffers;
      densityBuffer = b.density;
      positionsBuffer = b.positions;
      densityFBuffer = b.densityF;
      blurTmpBuffer = b.blurTmp;
      gradientBuffer = b.gradient;
      endpointFlagsBuffer = b.endpointFlags;
      smoothBufBuffer = b.smoothBuf;
      stagingBuffer = b.staging;
      resampleParamsBuffer = b.resampleParams;
      dirDensityUBuffer = b.dirDensityU;
      dirDensityFBuffer = b.dirDensityF;
      dirGradientBuffer = b.dirGradient;
      maxDensityBufBuffer = b.maxDensityBuf;

      // Write new data into reused buffers
      device.queue.writeBuffer(positionsBuffer, 0, positionsData);
      device.queue.writeBuffer(endpointFlagsBuffer, 0, endpointFlagsData);
      device.queue.writeBuffer(resampleParamsBuffer, 0, new Uint32Array([ne]));
    } else {
      // Destroy old pool
      if (this.pool) {
        for (const buf of Object.values(this.pool.buffers)) {
          if (buf) (buf as GPUBuffer).destroy();
        }
      }

      // Create new buffers
      densityBuffer = device.createBuffer({ size: gridCells * 4, usage: GPUBufferUsage.STORAGE });
      positionsBuffer = device.createBuffer({ size: totalPts * 2 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(positionsBuffer, 0, positionsData);
      densityFBuffer = device.createBuffer({ size: gridCells * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      blurTmpBuffer = device.createBuffer({ size: gridCells * 4, usage: GPUBufferUsage.STORAGE });
      gradientBuffer = device.createBuffer({ size: gridCells * 2 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      smoothBufBuffer = device.createBuffer({ size: totalPts * 2 * 4, usage: GPUBufferUsage.STORAGE });
      stagingBuffer = device.createBuffer({ size: totalPts * 2 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      resampleParamsBuffer = device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(resampleParamsBuffer, 0, new Uint32Array([ne]));

      // endpointFlags: use COPY_DST + writeBuffer for reusability (not mappedAtCreation)
      endpointFlagsBuffer = device.createBuffer({ size: totalPts * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(endpointFlagsBuffer, 0, endpointFlagsData);

      // Directional KDEEB buffers
      if (numBins > 0) {
        dirDensityUBuffer = device.createBuffer({ size: numBins * gridCells * 4, usage: GPUBufferUsage.STORAGE });
        dirDensityFBuffer = device.createBuffer({ size: numBins * gridCells * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        dirGradientBuffer = device.createBuffer({ size: numBins * gridCells * 2 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        // Always create maxDensityBuf (even when adaptive is off) — needed as binding placeholder
        maxDensityBufBuffer = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      }

      // Save to pool
      this.pool = {
        ne, totalPts, gridCells, numBins, GW, GH,
        buffers: {
          density: densityBuffer,
          positions: positionsBuffer,
          densityF: densityFBuffer,
          blurTmp: blurTmpBuffer,
          gradient: gradientBuffer,
          endpointFlags: endpointFlagsBuffer,
          smoothBuf: smoothBufBuffer,
          staging: stagingBuffer,
          resampleParams: resampleParamsBuffer,
          dirDensityU: dirDensityUBuffer,
          dirDensityF: dirDensityFBuffer,
          dirGradient: dirGradientBuffer,
          maxDensityBuf: maxDensityBufBuffer,
        },
      };
    }

    // ── Workgroup counts ──
    const gridWg1d = Math.ceil(gridCells / 256);
    const gridWg2dX = Math.ceil(GW / 16);
    const gridWg2dY = Math.ceil(GH / 16);
    const blurXWgX = Math.ceil(GW / 128);
    const blurXWgY = GH;
    const blurYWgX = GW;
    const blurYWgY = Math.ceil(GH / 128);
    const ptWg = Math.ceil(totalPts / 256);
    const ptDataWg = Math.ceil(totalPts * 2 / 256);

    // ── Straggler detection (CPU, before GPU iterations) ──
    const scoreRes = worldExtent * 0.008;
    const scoreGW = Math.ceil(bboxW / scoreRes) + 1;
    const scoreGH = Math.ceil(bboxH / scoreRes) + 1;
    const scoreGrid = new Float32Array(scoreGW * scoreGH);

    // Quick density grid + edge scores: 8 sample points per edge
    // Pre-compute grid indices and splat in one pass, then score using cached indices
    const edgeCells = new Int32Array(ne * 8);  // cached grid cell indices (-1 = out of bounds)
    for (let ei = 0; ei < ne; ei++) {
      const e = dataEdges[ei];
      const s = nodes[e.source], t = nodes[e.target];
      for (let pi = 0; pi < 8; pi++) {
        const frac = (pi + 1) / 9;
        const px = s.x + (t.x - s.x) * frac;
        const py = s.y + (t.y - s.y) * frac;
        const gx = Math.floor((px - minX) / scoreRes) | 0;
        const gy = Math.floor((py - minY) / scoreRes) | 0;
        if (gx >= 0 && gx < scoreGW && gy >= 0 && gy < scoreGH) {
          const cell = gy * scoreGW + gx;
          edgeCells[ei * 8 + pi] = cell;
          scoreGrid[cell] += 1;
        } else {
          edgeCells[ei * 8 + pi] = -1;
        }
      }
    }

    const edgeScores = new Float32Array(ne);
    for (let ei = 0; ei < ne; ei++) {
      let total = 0, count = 0;
      for (let pi = 0; pi < 8; pi++) {
        const cell = edgeCells[ei * 8 + pi];
        if (cell >= 0) {
          total += scoreGrid[cell];
          count++;
        }
      }
      edgeScores[ei] = count > 0 ? total / count : 0;
    }

    const sortedScores = Float32Array.from(edgeScores).sort();
    const stragglerThreshold = sortedScores[Math.floor(ne * 0.15)] || 0;
    const stragglerFlagsData = new Uint32Array(totalPts);
    for (let ei = 0; ei < ne; ei++) {
      if (edgeScores[ei] <= stragglerThreshold) {
        const base = ei * SAMPLES;
        for (let pi = 0; pi < SAMPLES; pi++) {
          stragglerFlagsData[base + pi] = 1;
        }
      }
    }

    let stragglerFlagsBuffer: GPUBuffer | undefined;
    let preParamsBuffer: GPUBuffer | undefined;
    let preBlurParamsBuffer: GPUBuffer | undefined;
    let preKernelBuffer: GPUBuffer | undefined;
    let iterBuffers: { params: GPUBuffer; blurParams: GPUBuffer; kernel: GPUBuffer }[] = [];

    try {

    stragglerFlagsBuffer = device.createBuffer({
      size: totalPts * 4,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Uint32Array(stragglerFlagsBuffer.getMappedRange()).set(stragglerFlagsData);
    stragglerFlagsBuffer.unmap();

    // ── Straggler pre-iterations (wide sigma, boosted step) ──
    const preSigma = sigmaStart * 1.5;
    const preStep = stepStart * 3;
    const preBlurSigma = preSigma / GRID_RES;
    const preRadius = Math.ceil(preBlurSigma * 3);

    const preParamsData = new ArrayBuffer(64);
    const preU32 = new Uint32Array(preParamsData);
    const preF32 = new Float32Array(preParamsData);
    preU32[0] = GW; preU32[1] = GH; preU32[2] = totalPts;
    preF32[3] = preStep; preF32[4] = minX; preF32[5] = minY; preF32[6] = GRID_RES;
    preU32[7] = SAMPLES; preF32[8] = gradientTau; preF32[9] = endpointDampWidth;
    preU32[10] = 1; preU32[11] = SAMPLES - 1; preU32[12] = 0;
    preF32[13] = 0; preU32[14] = 0; preU32[15] = 0;

    preParamsBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(preParamsBuffer, 0, preParamsData);

    preBlurParamsBuffer = device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(preBlurParamsBuffer, 0, new Int32Array([preRadius]));

    const preKSize = preRadius * 2 + 1;
    const preKernelData = new Float32Array(kernelPadded);
    let preKSum = 0;
    for (let i = 0; i < preKSize; i++) {
      const d = i - preRadius;
      preKernelData[i] = Math.exp(-0.5 * (d * d) / (preBlurSigma * preBlurSigma));
      preKSum += preKernelData[i];
    }
    for (let i = 0; i < preKSize; i++) preKernelData[i] /= preKSum;

    preKernelBuffer = device.createBuffer({ size: kernelPadded * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(preKernelBuffer, 0, preKernelData);

    // Pre-iteration bind groups
    const preClearBG = device.createBindGroup({ layout: this.clearPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: densityBuffer } }, { binding: 1, resource: { buffer: preParamsBuffer } },
    ]});
    const preSplatBG = device.createBindGroup({ layout: this.splatPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: densityBuffer } }, { binding: 1, resource: { buffer: preParamsBuffer } },
      { binding: 2, resource: { buffer: positionsBuffer } }, { binding: 8, resource: { buffer: endpointFlagsBuffer } },
    ]});
    const preConvertBG = device.createBindGroup({ layout: this.convertPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: densityBuffer } }, { binding: 1, resource: { buffer: preParamsBuffer } },
      { binding: 3, resource: { buffer: densityFBuffer } },
    ]});
    const preBlurXBG = device.createBindGroup({ layout: this.blurXPipeline.getBindGroupLayout(0), entries: [
      { binding: 1, resource: { buffer: preParamsBuffer } }, { binding: 3, resource: { buffer: densityFBuffer } },
      { binding: 4, resource: { buffer: blurTmpBuffer } }, { binding: 5, resource: { buffer: preKernelBuffer } },
      { binding: 6, resource: { buffer: preBlurParamsBuffer } },
    ]});
    const preBlurYBG = device.createBindGroup({ layout: this.blurYPipeline.getBindGroupLayout(0), entries: [
      { binding: 1, resource: { buffer: preParamsBuffer } }, { binding: 3, resource: { buffer: densityFBuffer } },
      { binding: 4, resource: { buffer: blurTmpBuffer } }, { binding: 5, resource: { buffer: preKernelBuffer } },
      { binding: 6, resource: { buffer: preBlurParamsBuffer } },
    ]});
    const preGradBG = device.createBindGroup({ layout: this.gradientPipeline.getBindGroupLayout(0), entries: [
      { binding: 1, resource: { buffer: preParamsBuffer } }, { binding: 3, resource: { buffer: densityFBuffer } },
      { binding: 7, resource: { buffer: gradientBuffer } },
    ]});
    const stragglerBG = device.createBindGroup({
      layout: this.stragglerAdvectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: { buffer: preParamsBuffer } },
        { binding: 2, resource: { buffer: positionsBuffer } },
        { binding: 7, resource: { buffer: gradientBuffer } },
        { binding: 8, resource: { buffer: endpointFlagsBuffer } },
        { binding: 11, resource: { buffer: stragglerFlagsBuffer } },
      ],
    });

    // Run 2 pre-iterations: clear → splat → convert → blur_x → blur_y → gradient → straggler_advect
    const preEnc = device.createCommandEncoder();
    for (let preIter = 0; preIter < 2; preIter++) {
      const pass = preEnc.beginComputePass();
      pass.setPipeline(this.clearPipeline); pass.setBindGroup(0, preClearBG); pass.dispatchWorkgroups(gridWg1d);
      pass.setPipeline(this.splatPipeline); pass.setBindGroup(0, preSplatBG); pass.dispatchWorkgroups(ptWg);
      pass.setPipeline(this.convertPipeline); pass.setBindGroup(0, preConvertBG); pass.dispatchWorkgroups(gridWg1d);
      pass.setPipeline(this.blurXPipeline); pass.setBindGroup(0, preBlurXBG); pass.dispatchWorkgroups(blurXWgX, blurXWgY);
      pass.setPipeline(this.blurYPipeline); pass.setBindGroup(0, preBlurYBG); pass.dispatchWorkgroups(blurYWgX, blurYWgY);
      pass.setPipeline(this.gradientPipeline); pass.setBindGroup(0, preGradBG); pass.dispatchWorkgroups(gridWg2dX, gridWg2dY);
      pass.setPipeline(this.stragglerAdvectPipeline); pass.setBindGroup(0, stragglerBG); pass.dispatchWorkgroups(ptWg);
      pass.end();
    }
    device.queue.submit([preEnc.finish()]);

    // ── Pre-compute all iteration parameters ──
    const iterParams: { step: number; radius: number; blurSigma: number }[] = [];
    for (let iter = 0; iter < iterations; iter++) {
      const frac = iter / Math.max(iterations - 1, 1);
      const sigma = sigmaStart * (1 - frac) + sigmaEnd * frac;
      const step = stepStart * (1 - frac) + stepEnd * frac;
      const blurSigma = sigma / GRID_RES;
      const radius = Math.ceil(blurSigma * 3);
      iterParams.push({ step, radius, blurSigma });
    }

    // ── Create per-iteration param/blur/kernel buffers and upload all data ──
    iterBuffers = [];
    for (let iter = 0; iter < iterations; iter++) {
      const { step, radius, blurSigma } = iterParams[iter];

      const pb = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const paramsData = new ArrayBuffer(64);
      const u32v = new Uint32Array(paramsData);
      const f32v = new Float32Array(paramsData);
      u32v[0] = GW; u32v[1] = GH; u32v[2] = totalPts;
      f32v[3] = step; f32v[4] = minX; f32v[5] = minY; f32v[6] = GRID_RES;
      u32v[7] = SAMPLES; f32v[8] = gradientTau; f32v[9] = endpointDampWidth;
      u32v[10] = splatLo; u32v[11] = splatHi; u32v[12] = numBins;
      f32v[13] = perpBias; u32v[14] = adaptiveAttraction ? 1 : 0; u32v[15] = 0;
      device.queue.writeBuffer(pb, 0, paramsData);

      const bpb = device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(bpb, 0, new Int32Array([radius]));

      const kb = device.createBuffer({ size: kernelPadded * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const kSize = radius * 2 + 1;
      const kernelData = new Float32Array(kernelPadded);
      let kSum = 0;
      for (let i = 0; i < kSize; i++) {
        const d = i - radius;
        kernelData[i] = Math.exp(-0.5 * (d * d) / (blurSigma * blurSigma));
        kSum += kernelData[i];
      }
      for (let i = 0; i < kSize; i++) kernelData[i] /= kSum;
      device.queue.writeBuffer(kb, 0, kernelData);

      iterBuffers.push({ params: pb, blurParams: bpb, kernel: kb });
    }

    // ── Directional workgroup counts ──
    const dirGridTotalWg = numBins > 0 ? Math.ceil(numBins * gridCells / 256) : 0;

    // ── Single command encoder for all iterations ──
    const enc = device.createCommandEncoder();

    for (let iter = 0; iter < iterations; iter++) {
      const ib = iterBuffers[iter];

      // Shared bind groups for smooth/relinearize/resample (used by both paths)
      const iterSmoothCopyBG = device.createBindGroup({ layout: this.smoothCopyPipeline.getBindGroupLayout(0), entries: [
        { binding: 1, resource: { buffer: ib.params } }, { binding: 2, resource: { buffer: positionsBuffer } },
        { binding: 9, resource: { buffer: smoothBufBuffer } },
      ]});
      const iterSmoothBG = device.createBindGroup({ layout: this.smoothPipeline.getBindGroupLayout(0), entries: [
        { binding: 1, resource: { buffer: ib.params } }, { binding: 2, resource: { buffer: positionsBuffer } },
        { binding: 8, resource: { buffer: endpointFlagsBuffer } }, { binding: 9, resource: { buffer: smoothBufBuffer } },
      ]});
      const iterRelinBG = device.createBindGroup({ layout: this.relinearizePipeline.getBindGroupLayout(0), entries: [
        { binding: 1, resource: { buffer: ib.params } }, { binding: 2, resource: { buffer: positionsBuffer } },
        { binding: 8, resource: { buffer: endpointFlagsBuffer } },
      ]});
      const iterResampleBG = device.createBindGroup({ layout: this.resamplePipeline.getBindGroupLayout(0), entries: [
        { binding: 1, resource: { buffer: ib.params } }, { binding: 2, resource: { buffer: positionsBuffer } },
        { binding: 10, resource: { buffer: resampleParamsBuffer } },
      ]});

      if (numBins > 0 && dirDensityUBuffer && dirDensityFBuffer && dirGradientBuffer) {
        // ── Directional KDEEB path ──

        // Bind groups for blur/gradient (reused per-bin with buffer copies)
        const iterBlurXBG = device.createBindGroup({ layout: this.blurXPipeline.getBindGroupLayout(0), entries: [
          { binding: 1, resource: { buffer: ib.params } }, { binding: 3, resource: { buffer: densityFBuffer } },
          { binding: 4, resource: { buffer: blurTmpBuffer } }, { binding: 5, resource: { buffer: ib.kernel } },
          { binding: 6, resource: { buffer: ib.blurParams } },
        ]});
        const iterBlurYBG = device.createBindGroup({ layout: this.blurYPipeline.getBindGroupLayout(0), entries: [
          { binding: 1, resource: { buffer: ib.params } }, { binding: 3, resource: { buffer: densityFBuffer } },
          { binding: 4, resource: { buffer: blurTmpBuffer } }, { binding: 5, resource: { buffer: ib.kernel } },
          { binding: 6, resource: { buffer: ib.blurParams } },
        ]});
        const iterGradBG = device.createBindGroup({ layout: this.gradientPipeline.getBindGroupLayout(0), entries: [
          { binding: 1, resource: { buffer: ib.params } }, { binding: 3, resource: { buffer: densityFBuffer } },
          { binding: 7, resource: { buffer: gradientBuffer } },
        ]});

        // 1. Clear → Splat → Convert directional density
        const dirClearBG = device.createBindGroup({ layout: this.dirClearPipeline.getBindGroupLayout(0), entries: [
          { binding: 12, resource: { buffer: dirDensityUBuffer } }, { binding: 1, resource: { buffer: ib.params } },
        ]});
        const dirSplatBG = device.createBindGroup({ layout: this.dirSplatPipeline.getBindGroupLayout(0), entries: [
          { binding: 12, resource: { buffer: dirDensityUBuffer } }, { binding: 1, resource: { buffer: ib.params } },
          { binding: 2, resource: { buffer: positionsBuffer } }, { binding: 8, resource: { buffer: endpointFlagsBuffer } },
        ]});
        const dirConvertBG = device.createBindGroup({ layout: this.dirConvertPipeline.getBindGroupLayout(0), entries: [
          { binding: 12, resource: { buffer: dirDensityUBuffer } }, { binding: 1, resource: { buffer: ib.params } },
          { binding: 13, resource: { buffer: dirDensityFBuffer } },
        ]});

        let p = enc.beginComputePass();
        p.setPipeline(this.dirClearPipeline); p.setBindGroup(0, dirClearBG); p.dispatchWorkgroups(dirGridTotalWg);
        p.setPipeline(this.dirSplatPipeline); p.setBindGroup(0, dirSplatBG); p.dispatchWorkgroups(ptWg);
        p.setPipeline(this.dirConvertPipeline); p.setBindGroup(0, dirConvertBG); p.dispatchWorkgroups(dirGridTotalWg);
        p.end();

        // 2. Per-bin blur + gradient (reuse existing shaders via buffer copies)
        const binBytes = gridCells * 4;
        const gradBinBytes = gridCells * 2 * 4;

        for (let b = 0; b < numBins; b++) {
          // Copy bin slice: dirDensityF[b*gridCells] → densityFBuffer
          enc.copyBufferToBuffer(dirDensityFBuffer, b * binBytes, densityFBuffer, 0, binBytes);

          // Blur + gradient in a compute pass
          const bp = enc.beginComputePass();
          bp.setPipeline(this.blurXPipeline); bp.setBindGroup(0, iterBlurXBG); bp.dispatchWorkgroups(blurXWgX, blurXWgY);
          bp.setPipeline(this.blurYPipeline); bp.setBindGroup(0, iterBlurYBG); bp.dispatchWorkgroups(blurYWgX, blurYWgY);
          bp.setPipeline(this.gradientPipeline); bp.setBindGroup(0, iterGradBG); bp.dispatchWorkgroups(gridWg2dX, gridWg2dY);
          bp.end();

          // Copy blurred density back: densityFBuffer → dirDensityF[b*gridCells]
          enc.copyBufferToBuffer(densityFBuffer, 0, dirDensityFBuffer, b * binBytes, binBytes);
          // Copy gradient: gradientBuffer → dirGradient[b*gridCells*2]
          enc.copyBufferToBuffer(gradientBuffer, 0, dirGradientBuffer, b * gradBinBytes, gradBinBytes);
        }

        // Pass A: sumDirBins
        if (adaptiveAttraction && maxDensityBufBuffer) {
          const sumBinsBG = device.createBindGroup({ layout: this.sumDirBinsPipeline.getBindGroupLayout(0), entries: [
            { binding: 13, resource: { buffer: dirDensityFBuffer } }, { binding: 3, resource: { buffer: densityFBuffer } },
            { binding: 1, resource: { buffer: ib.params } },
          ]});
          let passA = enc.beginComputePass();
          passA.setPipeline(this.sumDirBinsPipeline); passA.setBindGroup(0, sumBinsBG);
          passA.dispatchWorkgroups(gridWg1d);
          passA.end();

          // Pass B: maxDensityClear + maxDensityReduce
          const maxClearBG = device.createBindGroup({ layout: this.maxDensityClearPipeline.getBindGroupLayout(0), entries: [
            { binding: 15, resource: { buffer: maxDensityBufBuffer } },
          ]});
          const maxReduceBG = device.createBindGroup({ layout: this.maxDensityReducePipeline.getBindGroupLayout(0), entries: [
            { binding: 3, resource: { buffer: densityFBuffer } }, { binding: 15, resource: { buffer: maxDensityBufBuffer } },
            { binding: 1, resource: { buffer: ib.params } },
          ]});
          let passB = enc.beginComputePass();
          passB.setPipeline(this.maxDensityClearPipeline); passB.setBindGroup(0, maxClearBG); passB.dispatchWorkgroups(1);
          passB.setPipeline(this.maxDensityReducePipeline); passB.setBindGroup(0, maxReduceBG); passB.dispatchWorkgroups(gridWg1d);
          passB.end();
        }

        // Pass C: advectDirectional
        const advDirBG = device.createBindGroup({ layout: this.advectDirectionalPipeline.getBindGroupLayout(0), entries: [
          { binding: 2, resource: { buffer: positionsBuffer } }, { binding: 14, resource: { buffer: dirGradientBuffer } },
          { binding: 8, resource: { buffer: endpointFlagsBuffer } }, { binding: 3, resource: { buffer: densityFBuffer } },
          { binding: 15, resource: { buffer: maxDensityBufBuffer! } },
          { binding: 1, resource: { buffer: ib.params } },
        ]});
        let passC = enc.beginComputePass();
        passC.setPipeline(this.advectDirectionalPipeline); passC.setBindGroup(0, advDirBG);
        passC.dispatchWorkgroups(ptWg);
        passC.end();

        // Pass D: smoothCopy + smooth + relinearize + resample
        let passD = enc.beginComputePass();
        passD.setPipeline(this.smoothCopyPipeline); passD.setBindGroup(0, iterSmoothCopyBG);
        passD.dispatchWorkgroups(ptDataWg);
        passD.setPipeline(this.smoothPipeline); passD.setBindGroup(0, iterSmoothBG);
        passD.dispatchWorkgroups(ptWg);
        passD.setPipeline(this.relinearizePipeline); passD.setBindGroup(0, iterRelinBG);
        passD.dispatchWorkgroups(ptWg);
        if (iter < iterations - 2) {
          passD.setPipeline(this.resamplePipeline); passD.setBindGroup(0, iterResampleBG);
          passD.dispatchWorkgroups(ne);
        }
        passD.end();

      } else {
        // ── Non-directional fallback (original path) ──
        const iterClearBG = device.createBindGroup({ layout: this.clearPipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: densityBuffer } }, { binding: 1, resource: { buffer: ib.params } },
        ]});
        const iterSplatBG = device.createBindGroup({ layout: this.splatPipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: densityBuffer } }, { binding: 1, resource: { buffer: ib.params } },
          { binding: 2, resource: { buffer: positionsBuffer } }, { binding: 8, resource: { buffer: endpointFlagsBuffer } },
        ]});
        const iterConvertBG = device.createBindGroup({ layout: this.convertPipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: densityBuffer } }, { binding: 1, resource: { buffer: ib.params } },
          { binding: 3, resource: { buffer: densityFBuffer } },
        ]});
        const iterBlurXBG = device.createBindGroup({ layout: this.blurXPipeline.getBindGroupLayout(0), entries: [
          { binding: 1, resource: { buffer: ib.params } }, { binding: 3, resource: { buffer: densityFBuffer } },
          { binding: 4, resource: { buffer: blurTmpBuffer } }, { binding: 5, resource: { buffer: ib.kernel } },
          { binding: 6, resource: { buffer: ib.blurParams } },
        ]});
        const iterBlurYBG = device.createBindGroup({ layout: this.blurYPipeline.getBindGroupLayout(0), entries: [
          { binding: 1, resource: { buffer: ib.params } }, { binding: 3, resource: { buffer: densityFBuffer } },
          { binding: 4, resource: { buffer: blurTmpBuffer } }, { binding: 5, resource: { buffer: ib.kernel } },
          { binding: 6, resource: { buffer: ib.blurParams } },
        ]});
        const iterGradBG = device.createBindGroup({ layout: this.gradientPipeline.getBindGroupLayout(0), entries: [
          { binding: 1, resource: { buffer: ib.params } }, { binding: 3, resource: { buffer: densityFBuffer } },
          { binding: 7, resource: { buffer: gradientBuffer } },
        ]});
        const iterAdvectBG = device.createBindGroup({ layout: this.advectPipeline.getBindGroupLayout(0), entries: [
          { binding: 1, resource: { buffer: ib.params } }, { binding: 2, resource: { buffer: positionsBuffer } },
          { binding: 7, resource: { buffer: gradientBuffer } }, { binding: 8, resource: { buffer: endpointFlagsBuffer } },
        ]});

        // Pass 1: clear → splat → convert
        let pass = enc.beginComputePass();
        pass.setPipeline(this.clearPipeline); pass.setBindGroup(0, iterClearBG); pass.dispatchWorkgroups(gridWg1d);
        pass.setPipeline(this.splatPipeline); pass.setBindGroup(0, iterSplatBG); pass.dispatchWorkgroups(ptWg);
        pass.setPipeline(this.convertPipeline); pass.setBindGroup(0, iterConvertBG); pass.dispatchWorkgroups(gridWg1d);
        pass.end();

        // Pass 2: blurX → blurY
        pass = enc.beginComputePass();
        pass.setPipeline(this.blurXPipeline); pass.setBindGroup(0, iterBlurXBG); pass.dispatchWorkgroups(blurXWgX, blurXWgY);
        pass.setPipeline(this.blurYPipeline); pass.setBindGroup(0, iterBlurYBG); pass.dispatchWorkgroups(blurYWgX, blurYWgY);
        pass.end();

        // Pass 3: gradient
        pass = enc.beginComputePass();
        pass.setPipeline(this.gradientPipeline); pass.setBindGroup(0, iterGradBG); pass.dispatchWorkgroups(gridWg2dX, gridWg2dY);
        pass.end();

        // Pass 4: advect + smooth chain
        pass = enc.beginComputePass();
        pass.setPipeline(this.advectPipeline); pass.setBindGroup(0, iterAdvectBG); pass.dispatchWorkgroups(ptWg);
        pass.setPipeline(this.smoothCopyPipeline); pass.setBindGroup(0, iterSmoothCopyBG); pass.dispatchWorkgroups(ptDataWg);
        pass.setPipeline(this.smoothPipeline); pass.setBindGroup(0, iterSmoothBG); pass.dispatchWorkgroups(ptWg);
        pass.setPipeline(this.relinearizePipeline); pass.setBindGroup(0, iterRelinBG); pass.dispatchWorkgroups(ptWg);
        if (iter < iterations - 2) {
          pass.setPipeline(this.resamplePipeline); pass.setBindGroup(0, iterResampleBG); pass.dispatchWorkgroups(ne);
        }
        pass.end();
      }
    }

    // ── Post-smooth loop: smooth + relinearize (no advection) ──
    if (postSmoothIters > 0) {
      // Create a params buffer for post-smooth (use last iteration's step, doesn't matter for smooth)
      const lastIb = iterBuffers[iterations - 1];

      for (let ps = 0; ps < postSmoothIters; ps++) {
        const psSmoothCopyBG = device.createBindGroup({ layout: this.smoothCopyPipeline.getBindGroupLayout(0), entries: [
          { binding: 1, resource: { buffer: lastIb.params } }, { binding: 2, resource: { buffer: positionsBuffer } },
          { binding: 9, resource: { buffer: smoothBufBuffer } },
        ]});
        const psSmoothBG = device.createBindGroup({ layout: this.smoothPipeline.getBindGroupLayout(0), entries: [
          { binding: 1, resource: { buffer: lastIb.params } }, { binding: 2, resource: { buffer: positionsBuffer } },
          { binding: 8, resource: { buffer: endpointFlagsBuffer } }, { binding: 9, resource: { buffer: smoothBufBuffer } },
        ]});
        const psRelinBG = device.createBindGroup({ layout: this.relinearizePipeline.getBindGroupLayout(0), entries: [
          { binding: 1, resource: { buffer: lastIb.params } }, { binding: 2, resource: { buffer: positionsBuffer } },
          { binding: 8, resource: { buffer: endpointFlagsBuffer } },
        ]});

        const psPass = enc.beginComputePass();
        psPass.setPipeline(this.smoothCopyPipeline); psPass.setBindGroup(0, psSmoothCopyBG); psPass.dispatchWorkgroups(ptDataWg);
        psPass.setPipeline(this.smoothPipeline); psPass.setBindGroup(0, psSmoothBG); psPass.dispatchWorkgroups(ptWg);
        psPass.setPipeline(this.relinearizePipeline); psPass.setBindGroup(0, psRelinBG); psPass.dispatchWorkgroups(ptWg);
        psPass.end();
      }
    }

    // Single submission for ALL iterations + post-smooth
    device.queue.submit([enc.finish()]);

    // ── Readback ──
    const readEnc = device.createCommandEncoder();
    readEnc.copyBufferToBuffer(positionsBuffer, 0, stagingBuffer, 0, totalPts * 2 * 4);
    device.queue.submit([readEnc.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const resultData = new Float32Array(stagingBuffer.getMappedRange().slice(0));
    stagingBuffer.unmap();

    // ── Map results ──
    const result: Pt[][] = edges.map(e => {
      const s = nodes[e.source];
      const t = nodes[e.target];
      return s && t ? [{ x: s.x, y: s.y }, { x: t.x, y: t.y }] : [];
    });

    for (let fi = 0; fi < ne; fi++) {
      const base = fi * SAMPLES;
      const pts: Pt[] = [];
      for (let pi = 0; pi < SAMPLES; pi++) {
        pts.push({ x: resultData[(base + pi) * 2], y: resultData[(base + pi) * 2 + 1] });
      }
      result[origIndices[fi]] = pts;
    }

    return { paths: result, backend: 'webgpu' };

    } finally {
      // Destroy temporary buffers even if an exception occurred
      stragglerFlagsBuffer?.destroy();
      preParamsBuffer?.destroy();
      preBlurParamsBuffer?.destroy();
      preKernelBuffer?.destroy();
      for (const ib of iterBuffers) {
        ib.params?.destroy();
        ib.blurParams?.destroy();
        ib.kernel?.destroy();
      }
    }
  }
}
