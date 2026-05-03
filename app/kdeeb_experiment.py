"""
KDEEB Edge Bundling — Python experiment harness.

Faithful port of kdeeb.ts. Tweak parameters at the bottom and re-run.
Usage:  python kdeeb_experiment.py
"""

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from scipy.ndimage import gaussian_filter

# ── KDEEB algorithm ──────────────────────────────────────────────────────────

def kdeeb_bundle(
    node_pos: dict[str, tuple[float, float]],
    edges: list[tuple[str, str]],
    samples: int = 64,
    iterations: int = 8,
    gradient_tau: float = 0.06,
    pin_zone: float = 0.18,
    grid_res_factor: float = 0.002,
    sigma_start_factor: float = 0.024,
    sigma_end_factor: float = 0.004,
    step_start_factor: float = 0.009,
    step_end_factor: float = 0.0015,
    straggler_pct: float = 0.15,
    straggler_pre_iters: int = 2,
    straggler_step_mult: float = 3.0,
    perp_bias: float = 0.0,
    post_smooth_iters: int = 0,
    splat_skip_zone: float = 0.0,
    directional_bins: int = 0,
    adaptive_attraction: bool = False,
    ink_minimize_iters: int = 0,
) -> np.ndarray:
    """
    Returns pts array of shape (n_edges, samples, 2).
    """
    eps = 1e-6

    # Filter self-loops / missing nodes
    valid = []
    for i, (s, t) in enumerate(edges):
        if s not in node_pos or t not in node_pos:
            continue
        sx, sy = node_pos[s]
        tx, ty = node_pos[t]
        if abs(sx - tx) > eps or abs(sy - ty) > eps:
            valid.append(i)

    ne = len(valid)
    if ne == 0:
        return np.zeros((len(edges), samples, 2))

    # Bounding box with 10% padding
    all_xy = np.array(list(node_pos.values()))
    mn = all_xy.min(axis=0)
    mx = all_xy.max(axis=0)
    pad = (mx - mn) * 0.1
    pad = np.where(pad < 1, 50.0, pad)
    mn -= pad
    mx += pad
    bbox = mx - mn
    world_extent = max(bbox)

    # Auto-scaled parameters
    GRID_RES = world_extent * grid_res_factor
    GW = int(np.ceil(bbox[0] / GRID_RES)) + 1
    GH = int(np.ceil(bbox[1] / GRID_RES)) + 1
    sigma_start = world_extent * sigma_start_factor
    sigma_end = world_extent * sigma_end_factor
    step_start = world_extent * step_start_factor
    step_end = world_extent * step_end_factor

    # Initialize points as straight lines: shape (ne, samples, 2)
    pts = np.zeros((ne, samples, 2), dtype=np.float64)
    for fi, ei in enumerate(valid):
        s, t = edges[ei]
        sx, sy = node_pos[s]
        tx, ty = node_pos[t]
        fracs = np.linspace(0, 1, samples)
        pts[fi, :, 0] = sx + (tx - sx) * fracs
        pts[fi, :, 1] = sy + (ty - sy) * fracs

    def get_splat_range(splat_zone):
        if splat_zone > 0:
            lo = max(1, int(np.ceil(splat_zone * (samples - 1))))
            hi = min(samples - 1, samples - 1 - lo)
            if lo >= hi:
                lo, hi = 1, samples - 1
        else:
            lo, hi = 1, samples - 1
        return lo, hi

    def splat_density(pts_arr, splat_zone=0.0):
        """Splat edge points into density grid.
        splat_zone: if > 0, skip this fraction of points on each end."""
        density = np.zeros((GH, GW), dtype=np.float64)
        lo, hi = get_splat_range(splat_zone)
        section = pts_arr[:, lo:hi, :]
        gx = np.floor((section[:, :, 0] - mn[0]) / GRID_RES).astype(int)
        gy = np.floor((section[:, :, 1] - mn[1]) / GRID_RES).astype(int)
        mask = (gx >= 0) & (gx < GW) & (gy >= 0) & (gy < GH)
        np.add.at(density, (gy[mask], gx[mask]), 1.0)
        return density

    def splat_directional(pts_arr, n_bins, splat_zone=0.0):
        """Splat into angular-binned density grids.
        Each point is splatted into the bin matching its local tangent angle.
        Returns array of shape (n_bins, GH, GW)."""
        grids = np.zeros((n_bins, GH, GW), dtype=np.float64)
        lo, hi = get_splat_range(splat_zone)
        section = pts_arr[:, lo:hi, :]

        # Local tangent: forward difference (approximate)
        if hi + 1 <= samples:
            tangent = pts_arr[:, lo+1:hi+1, :] - pts_arr[:, lo-1:hi-1, :]
        else:
            tangent = np.diff(section, axis=1)
            tangent = np.concatenate([tangent, tangent[:, -1:, :]], axis=1)

        # Angle in [0, pi) — direction is symmetric (A→B same bin as B→A)
        angles = np.arctan2(tangent[:, :, 1], tangent[:, :, 0]) % np.pi
        bin_idx = np.clip((angles / np.pi * n_bins).astype(int), 0, n_bins - 1)

        gx = np.floor((section[:, :, 0] - mn[0]) / GRID_RES).astype(int)
        gy = np.floor((section[:, :, 1] - mn[1]) / GRID_RES).astype(int)
        mask = (gx >= 0) & (gx < GW) & (gy >= 0) & (gy < GH)

        np.add.at(grids, (bin_idx[mask], gy[mask], gx[mask]), 1.0)
        return grids

    def compute_gradient(blurred):
        gy, gx = np.gradient(blurred)
        return gx, gy

    def advect(pts_arr, grad_x, grad_y, step, tau, perp_bias=0.0,
               density_at_pts=None, adaptive=False):
        """perp_bias in [0,1]: 0=full gradient, 1=perpendicular-only.
        density_at_pts: if provided + adaptive, scale step inversely with local density."""
        interior = pts_arr[:, 1:-1, :]
        gxi = np.floor((interior[:, :, 0] - mn[0]) / GRID_RES).astype(int)
        gyi = np.floor((interior[:, :, 1] - mn[1]) / GRID_RES).astype(int)
        gxi = np.clip(gxi, 0, GW - 1)
        gyi = np.clip(gyi, 0, GH - 1)

        dx = grad_x[gyi, gxi]
        dy = grad_y[gyi, gxi]

        if perp_bias > 0:
            tangent = pts_arr[:, 2:, :] - pts_arr[:, :-2, :]
            t_mag = np.sqrt((tangent**2).sum(axis=2, keepdims=True))
            t_mag = np.where(t_mag < 1e-9, 1.0, t_mag)
            tangent = tangent / t_mag
            tx = tangent[:, :, 0]
            ty = tangent[:, :, 1]
            dot = dx * tx + dy * ty
            perp_dx = dx - dot * tx
            perp_dy = dy - dot * ty
            dx = (1 - perp_bias) * dx + perp_bias * perp_dx
            dy = (1 - perp_bias) * dy + perp_bias * perp_dy

        mag = np.sqrt(dx**2 + dy**2)
        mag_safe = np.where(mag < 1e-9, 1.0, mag)
        mag_scale = mag / (mag_safe + tau)
        local_step = step * mag_scale

        # Adaptive: points in high-density areas (already bundled) get weaker pull,
        # stragglers in low-density areas get stronger pull.
        if adaptive and density_at_pts is not None:
            d = density_at_pts[gyi, gxi]
            d_max = d.max() if d.max() > 0 else 1.0
            # Scale: high density → 0.3x step, low density → 2.0x step
            adapt_scale = 2.0 - 1.7 * (d / d_max)
            local_step = local_step * adapt_scale

        pts_arr[:, 1:-1, 0] += local_step * dx / mag_safe
        pts_arr[:, 1:-1, 1] += local_step * dy / mag_safe

    def smooth(pts_arr):
        smoothed = pts_arr.copy()
        pts_arr[:, 1:-1, :] = (
            0.5 * smoothed[:, 1:-1, :]
            + 0.25 * (smoothed[:, :-2, :] + smoothed[:, 2:, :])
        )

    def pin_endpoints(pts_arr):
        for fi, ei in enumerate(valid):
            s, t = edges[ei]
            pts_arr[fi, 0] = node_pos[s]
            pts_arr[fi, -1] = node_pos[t]

    def relinearize_endpoints(pts_arr, zone):
        anchor_lo = int(np.ceil(zone * (samples - 1)))
        anchor_hi = samples - 1 - anchor_lo
        for fi, ei in enumerate(valid):
            s, t = edges[ei]
            sx, sy = node_pos[s]
            tx, ty = node_pos[t]
            a_lo = pts_arr[fi, anchor_lo]
            a_hi = pts_arr[fi, anchor_hi]

            for pi in range(1, samples - 1):
                t_edge = pi / (samples - 1)
                if t_edge < zone:
                    local_t = t_edge / zone
                    blend = local_t * local_t * (3 - 2 * local_t)
                    straight = np.array([sx, sy]) + local_t * (a_lo - np.array([sx, sy]))
                    pts_arr[fi, pi] = straight + blend * (pts_arr[fi, pi] - straight)
                elif t_edge > 1 - zone:
                    local_t = (1 - t_edge) / zone
                    blend = local_t * local_t * (3 - 2 * local_t)
                    straight = np.array([tx, ty]) + local_t * (a_hi - np.array([tx, ty]))
                    pts_arr[fi, pi] = straight + blend * (pts_arr[fi, pi] - straight)

    def resample_arclength(pts_arr):
        out = np.zeros_like(pts_arr)
        for ei in range(pts_arr.shape[0]):
            diffs = np.diff(pts_arr[ei], axis=0)
            seg_lens = np.sqrt((diffs**2).sum(axis=1))
            cum_len = np.concatenate([[0], np.cumsum(seg_lens)])
            total = cum_len[-1]
            if total < 1e-6:
                out[ei] = pts_arr[ei]
                continue
            targets = np.linspace(0, total, samples)
            indices = np.searchsorted(cum_len, targets, side='right') - 1
            indices = np.clip(indices, 0, samples - 2)
            seg_start = cum_len[indices]
            seg_l = seg_lens[indices]
            t = np.where(seg_l > 1e-9, (targets - seg_start) / seg_l, 0)
            out[ei] = pts_arr[ei, indices] + t[:, None] * (
                pts_arr[ei, indices + 1] - pts_arr[ei, indices]
            )
            out[ei, 0] = pts_arr[ei, 0]
            out[ei, -1] = pts_arr[ei, -1]
        return out

    # ── Straggler pre-pass ──
    density = splat_density(pts)
    pre_sigma = sigma_start * 1.5 / GRID_RES
    blurred = gaussian_filter(density, sigma=pre_sigma)
    grad_x, grad_y = compute_gradient(blurred)

    # Score each edge
    edge_scores = np.zeros(ne)
    for fi in range(ne):
        interior = pts[fi, 1:-1]
        gxi = np.clip(np.floor((interior[:, 0] - mn[0]) / GRID_RES).astype(int), 0, GW - 1)
        gyi = np.clip(np.floor((interior[:, 1] - mn[1]) / GRID_RES).astype(int), 0, GH - 1)
        edge_scores[fi] = blurred[gyi, gxi].mean()

    threshold = np.percentile(edge_scores, straggler_pct * 100)
    is_straggler = edge_scores <= threshold

    pre_step = step_start * straggler_step_mult
    for _ in range(straggler_pre_iters):
        strag_pts = pts[is_straggler]
        if len(strag_pts) > 0:
            interior = strag_pts[:, 1:-1]
            gxi = np.clip(np.floor((interior[:, :, 0] - mn[0]) / GRID_RES).astype(int), 0, GW - 1)
            gyi = np.clip(np.floor((interior[:, :, 1] - mn[1]) / GRID_RES).astype(int), 0, GH - 1)
            dx = grad_x[gyi, gxi]
            dy = grad_y[gyi, gxi]
            mag = np.sqrt(dx**2 + dy**2)
            mag_safe = np.where(mag < 1e-9, 1.0, mag)
            strag_pts[:, 1:-1, 0] += pre_step * dx / mag_safe
            strag_pts[:, 1:-1, 1] += pre_step * dy / mag_safe
            pts[is_straggler] = strag_pts
        pin_endpoints(pts)

    # ── Main iterations ──
    for it in range(iterations):
        frac = it / max(iterations - 1, 1)
        sigma = sigma_start * (1 - frac) + sigma_end * frac
        step = step_start * (1 - frac) + step_end * frac
        blur_sigma = sigma / GRID_RES

        if directional_bins > 0:
            # Directional KDEEB: splat into angular bins, blur each,
            # then each point reads gradient from its own direction's bin.
            dir_grids = splat_directional(pts, directional_bins, splat_zone=splat_skip_zone)
            blurred_grids = np.zeros_like(dir_grids)
            grad_x_grids = np.zeros_like(dir_grids)
            grad_y_grids = np.zeros_like(dir_grids)
            for b in range(directional_bins):
                blurred_grids[b] = gaussian_filter(dir_grids[b], sigma=blur_sigma)
                gy_g, gx_g = np.gradient(blurred_grids[b])
                grad_x_grids[b] = gx_g
                grad_y_grids[b] = gy_g

            # Sum density across all bins for adaptive attraction
            total_blurred = blurred_grids.sum(axis=0) if adaptive_attraction else None

            # Composite gradient: each interior point uses its own bin
            interior = pts[:, 1:-1, :]
            tangent = pts[:, 2:, :] - pts[:, :-2, :]
            angles = np.arctan2(tangent[:, :, 1], tangent[:, :, 0]) % np.pi
            bin_idx = np.clip((angles / np.pi * directional_bins).astype(int), 0, directional_bins - 1)

            # Also blend in neighboring bins for smooth transitions
            gxi = np.clip(np.floor((interior[:, :, 0] - mn[0]) / GRID_RES).astype(int), 0, GW - 1)
            gyi = np.clip(np.floor((interior[:, :, 1] - mn[1]) / GRID_RES).astype(int), 0, GH - 1)

            # Primary bin + neighbors (wrap-around)
            b0 = bin_idx
            b_prev = (b0 - 1) % directional_bins
            b_next = (b0 + 1) % directional_bins

            gx_comp = (0.6 * grad_x_grids[b0, gyi, gxi] +
                       0.2 * grad_x_grids[b_prev, gyi, gxi] +
                       0.2 * grad_x_grids[b_next, gyi, gxi])
            gy_comp = (0.6 * grad_y_grids[b0, gyi, gxi] +
                       0.2 * grad_y_grids[b_prev, gyi, gxi] +
                       0.2 * grad_y_grids[b_next, gyi, gxi])

            # Build composite gradient arrays matching full grid shape
            grad_x_composite = np.zeros((GH, GW))
            grad_y_composite = np.zeros((GH, GW))
            # We need to pass per-point gradients, so store them directly
            # and use a custom advect path
            dx = gx_comp
            dy = gy_comp

            if perp_bias > 0:
                t_n = tangent / np.where(np.sqrt((tangent**2).sum(axis=2, keepdims=True)) < 1e-9, 1.0,
                                          np.sqrt((tangent**2).sum(axis=2, keepdims=True)))
                tx, ty = t_n[:,:,0], t_n[:,:,1]
                dot = dx * tx + dy * ty
                perp_dx = dx - dot * tx
                perp_dy = dy - dot * ty
                dx = (1 - perp_bias) * dx + perp_bias * perp_dx
                dy = (1 - perp_bias) * dy + perp_bias * perp_dy

            mag = np.sqrt(dx**2 + dy**2)
            mag_safe = np.where(mag < 1e-9, 1.0, mag)
            mag_scale = mag / (mag_safe + gradient_tau)
            local_step = step * mag_scale

            if adaptive_attraction and total_blurred is not None:
                d = total_blurred[gyi, gxi]
                d_max = d.max() if d.max() > 0 else 1.0
                adapt_scale = 2.0 - 1.7 * (d / d_max)
                local_step = local_step * adapt_scale

            pts[:, 1:-1, 0] += local_step * dx / mag_safe
            pts[:, 1:-1, 1] += local_step * dy / mag_safe
        else:
            density = splat_density(pts, splat_zone=splat_skip_zone)
            blurred = gaussian_filter(density, sigma=blur_sigma)
            grad_x, grad_y = compute_gradient(blurred)
            advect(pts, grad_x, grad_y, step, gradient_tau, perp_bias=perp_bias,
                   density_at_pts=blurred if adaptive_attraction else None,
                   adaptive=adaptive_attraction)
        smooth(pts)
        relinearize_endpoints(pts, pin_zone)
        pin_endpoints(pts)
        if it < iterations - 2:
            pts = resample_arclength(pts)

    # Post-smoothing: pure smoothing passes (no advection) to relax remaining kinks
    for _ in range(post_smooth_iters):
        smooth(pts)
        relinearize_endpoints(pts, pin_zone)
        pin_endpoints(pts)

    # Ink minimization: iteratively pull each point toward the midpoint of its
    # neighbors, shortening total edge length while preserving bundle structure.
    # Like Laplacian smoothing but weighted by how close neighbors are — tight
    # bundles stay tight, loose sections contract.
    if ink_minimize_iters > 0:
        for ink_it in range(ink_minimize_iters):
            # Strength decays: aggressive early, gentle later
            strength = 0.4 * (1 - ink_it / ink_minimize_iters)
            prev = pts[:, :-2, :]
            nxt = pts[:, 2:, :]
            mid = (prev + nxt) * 0.5
            # Pull toward neighbor midpoint (shortens total ink)
            pts[:, 1:-1, :] += strength * (mid - pts[:, 1:-1, :])
            relinearize_endpoints(pts, pin_zone)
            pin_endpoints(pts)

    # Map back to original edge order
    result = np.zeros((len(edges), samples, 2))
    for i, (s, t) in enumerate(edges):
        if s in node_pos and t in node_pos:
            result[i, 0] = node_pos[s]
            result[i, -1] = node_pos[t]
            fracs = np.linspace(0, 1, samples)
            sx, sy = node_pos[s]
            tx, ty = node_pos[t]
            result[i, :, 0] = sx + (tx - sx) * fracs
            result[i, :, 1] = sy + (ty - sy) * fracs
    for fi, ei in enumerate(valid):
        result[ei] = pts[fi]

    return result


# ── Graph generation ─────────────────────────────────────────────────────────

def generate_clustered_graph(
    n_clusters: int = 6,
    nodes_per_cluster: int = 15,
    intra_prob: float = 0.3,
    inter_prob: float = 0.04,
    spread: float = 150,
    cluster_spread: float = 500,
    seed: int = 42,
):
    """Generate a clustered graph similar to a knowledge graph."""
    rng = np.random.default_rng(seed)

    node_pos = {}
    node_cluster = {}
    nodes = []

    # Place cluster centers
    centers = rng.uniform(-cluster_spread, cluster_spread, (n_clusters, 2))

    for ci in range(n_clusters):
        cx, cy = centers[ci]
        for ni in range(nodes_per_cluster):
            nid = f"c{ci}_n{ni}"
            x = cx + rng.normal(0, spread)
            y = cy + rng.normal(0, spread)
            node_pos[nid] = (x, y)
            node_cluster[nid] = ci
            nodes.append(nid)

    # Generate edges
    edges = []
    for i, a in enumerate(nodes):
        for j, b in enumerate(nodes):
            if j <= i:
                continue
            same_cluster = node_cluster[a] == node_cluster[b]
            p = intra_prob if same_cluster else inter_prob
            if rng.random() < p:
                edges.append((a, b))

    return node_pos, edges, node_cluster


# ── Plotting ─────────────────────────────────────────────────────────────────

DARK_BG = "#1c1b22"
COMMUNITY_COLORS = [
    "#e06070", "#5aafea", "#68c87a", "#e8a850", "#b478d0",
    "#50c8c0", "#e87890", "#88a8e0", "#c8b040", "#d08868",
    "#70d0a0", "#c090c0", "#a0c040", "#6098b8", "#e07050",
    "#60d0d0",
]


def plot_bundled(
    node_pos, edges, node_cluster, bundled_paths,
    title="KDEEB", ax=None, edge_alpha=0.15, highlight_node=None,
):
    if ax is None:
        fig, ax = plt.subplots(1, 1, figsize=(12, 10), facecolor=DARK_BG)
    ax.set_facecolor(DARK_BG)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title(title, color="white", fontsize=14, pad=10)

    # Draw edges
    if highlight_node is not None:
        # Find connected edges
        connected = set()
        connected.add(highlight_node)
        for s, t in edges:
            if s == highlight_node:
                connected.add(t)
            if t == highlight_node:
                connected.add(s)

        for ei, (s, t) in enumerate(edges):
            path = bundled_paths[ei]
            is_incident = s == highlight_node or t == highlight_node
            ci = node_cluster.get(s, 0)
            color = COMMUNITY_COLORS[ci % len(COMMUNITY_COLORS)]
            if is_incident:
                ax.plot(path[:, 0], path[:, 1], color=color, alpha=0.7, lw=1.5, solid_capstyle="round")
            else:
                ax.plot(path[:, 0], path[:, 1], color="#8c82a0", alpha=0.03, lw=0.3)
    else:
        for ei, (s, t) in enumerate(edges):
            path = bundled_paths[ei]
            ci = node_cluster.get(s, 0)
            color = COMMUNITY_COLORS[ci % len(COMMUNITY_COLORS)]
            ax.plot(path[:, 0], path[:, 1], color=color, alpha=edge_alpha, lw=0.8, solid_capstyle="round")

    # Draw nodes
    for nid, (x, y) in node_pos.items():
        ci = node_cluster.get(nid, 0)
        color = COMMUNITY_COLORS[ci % len(COMMUNITY_COLORS)]
        alpha = 1.0
        if highlight_node is not None and nid not in connected:
            alpha = 0.12
        ax.plot(x, y, "o", color=color, markersize=5, alpha=alpha, markeredgecolor="white", markeredgewidth=0.3)

    return ax


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Generating graph...")
    node_pos, edges, node_cluster = generate_clustered_graph(
        n_clusters=12,
        nodes_per_cluster=30,
        intra_prob=0.2,
        inter_prob=0.02,
        spread=180,
        cluster_spread=800,
        seed=42,
    )
    print(f"  {len(node_pos)} nodes, {len(edges)} edges")

    # ── Parameter sets to compare ──
    configs = {
        "Baseline (no novel)": dict(
            gradient_tau=0.03,
            pin_zone=0.22,
            iterations=15,
            step_start_factor=0.012,
            splat_skip_zone=0.22,
            perp_bias=0.6,
            post_smooth_iters=8,
        ),
        "Dir4 + Adaptive": dict(
            gradient_tau=0.03,
            pin_zone=0.22,
            iterations=15,
            step_start_factor=0.012,
            splat_skip_zone=0.22,
            perp_bias=0.6,
            post_smooth_iters=8,
            directional_bins=4,
            adaptive_attraction=True,
        ),
        "Dir4 + Adapt + Ink 10": dict(
            gradient_tau=0.03,
            pin_zone=0.22,
            iterations=15,
            step_start_factor=0.012,
            splat_skip_zone=0.22,
            perp_bias=0.6,
            post_smooth_iters=8,
            directional_bins=4,
            adaptive_attraction=True,
            ink_minimize_iters=10,
        ),
        "Dir4 + lower perp 0.4": dict(
            gradient_tau=0.03,
            pin_zone=0.22,
            iterations=15,
            step_start_factor=0.012,
            splat_skip_zone=0.22,
            perp_bias=0.4,
            post_smooth_iters=8,
            directional_bins=4,
            adaptive_attraction=True,
        ),
        "Dir6 + Adaptive": dict(
            gradient_tau=0.03,
            pin_zone=0.22,
            iterations=15,
            step_start_factor=0.012,
            splat_skip_zone=0.22,
            perp_bias=0.6,
            post_smooth_iters=8,
            directional_bins=6,
            adaptive_attraction=True,
        ),
        "Dir4 + Adapt + more iters": dict(
            gradient_tau=0.03,
            pin_zone=0.22,
            iterations=20,
            step_start_factor=0.012,
            splat_skip_zone=0.22,
            perp_bias=0.6,
            post_smooth_iters=10,
            directional_bins=4,
            adaptive_attraction=True,
        ),
    }

    # Precompute all bundles
    all_paths = {}
    for label, params in configs.items():
        print(f"Bundling: {label}...")
        all_paths[label] = kdeeb_bundle(node_pos, edges, **params)

    # ── Overview plot ──
    fig, axes = plt.subplots(2, 3, figsize=(24, 16), facecolor=DARK_BG)
    for idx, (label, params) in enumerate(configs.items()):
        plot_bundled(node_pos, edges, node_cluster, all_paths[label], title=label, ax=axes.flat[idx])
    plt.tight_layout()
    plt.savefig("kdeeb_comparison.png", dpi=150, facecolor=DARK_BG)
    print("Saved kdeeb_comparison.png")

    # ── Zoomed-in comparison: Current vs best perp ──
    zoom_keys = [
        "Baseline (no novel)",
        "Dir4 + Adaptive",
    ]

    # Find a dense region to zoom into (cluster center with most edges)
    all_xy = np.array(list(node_pos.values()))
    cx, cy = all_xy.mean(axis=0)

    fig2, axes2 = plt.subplots(1, 2, figsize=(20, 10), facecolor=DARK_BG)
    for idx, key in enumerate(zoom_keys):
        ax = axes2[idx]
        plot_bundled(node_pos, edges, node_cluster, all_paths[key], title=f"{key} (zoomed)", ax=ax)
        # Zoom to center region
        zoom_r = 500
        ax.set_xlim(cx - zoom_r, cx + zoom_r)
        ax.set_ylim(cy - zoom_r, cy + zoom_r)
    plt.tight_layout()
    plt.savefig("kdeeb_zoomed.png", dpi=150, facecolor=DARK_BG)
    print("Saved kdeeb_zoomed.png")

    # ── Highlight comparison ──
    # Pick a node near center with many connections
    best_node = None
    best_count = 0
    for nid, (nx, ny) in node_pos.items():
        if abs(nx - cx) > 300 or abs(ny - cy) > 300:
            continue
        count = sum(1 for s, t in edges if s == nid or t == nid)
        if count > best_count:
            best_count = count
            best_node = nid

    if best_node:
        fig3, axes3 = plt.subplots(1, 2, figsize=(20, 10), facecolor=DARK_BG)
        for idx, key in enumerate(zoom_keys):
            ax = axes3[idx]
            plot_bundled(node_pos, edges, node_cluster, all_paths[key],
                        title=f"{key} (highlight {best_node})", ax=ax,
                        highlight_node=best_node)
            bx, by = node_pos[best_node]
            zoom_r = 600
            ax.set_xlim(bx - zoom_r, bx + zoom_r)
            ax.set_ylim(by - zoom_r, by + zoom_r)
        plt.tight_layout()
        plt.savefig("kdeeb_highlight.png", dpi=150, facecolor=DARK_BG)
        print(f"Saved kdeeb_highlight.png (node={best_node}, {best_count} connections)")

    plt.show()
