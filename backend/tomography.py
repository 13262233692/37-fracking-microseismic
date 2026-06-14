from __future__ import annotations
import gc
import logging
import numpy as np
from scipy.sparse import csr_matrix, vstack, diags, eye
from scipy.sparse.linalg import lsqr, LinearOperator
from skimage.measure import marching_cubes
from models import PArrival, Station, MicroseismicEvent, TomographyParams

logger = logging.getLogger(__name__)

EPS = 1e-12
MEMORY_WARNING_MB = 4096


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = np.radians(lat2 - lat1)
    dlon = np.radians(lon2 - lon1)
    a = np.sin(dlat / 2) ** 2 + np.cos(np.radians(lat1)) * np.cos(np.radians(lat2)) * np.sin(dlon / 2) ** 2
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
    return R * c


def _estimate_memory(n_rays: int, n_cells: int, smoothness: float, damping: float) -> dict:
    nnz_per_ray = 50
    G_nnz = n_rays * nnz_per_ray
    G_mb = G_nnz * 12 / 1024 ** 2
    reg_rows = 0
    reg_nnz = 0
    if smoothness > 0:
        reg_rows = 3 * n_cells
        reg_nnz = 2 * 3 * n_cells
    if damping > 0:
        reg_rows += n_cells
        reg_nnz += n_cells
    reg_mb = reg_nnz * 12 / 1024 ** 2
    dt_vec_mb = (n_rays + reg_rows) * 8 / 1024 ** 2
    model_vec_mb = n_cells * 8 / 1024 ** 2
    total_mb = G_mb + reg_mb + dt_vec_mb + model_vec_mb
    return {
        "G_nnz": G_nnz,
        "reg_rows": reg_rows,
        "reg_nnz": reg_nnz,
        "G_MB": round(G_mb, 2),
        "reg_MB": round(reg_mb, 2),
        "dt_MB": round(dt_vec_mb, 2),
        "model_MB": round(model_vec_mb, 2),
        "total_MB": round(total_mb, 2),
    }


def build_ray_matrix(
    arrivals: list[PArrival],
    stations: list[Station],
    events: list[MicroseismicEvent],
    params: TomographyParams,
) -> tuple[csr_matrix, np.ndarray, dict]:
    station_map = {s.id: s for s in stations}
    event_map = {e.id: e for e in events}
    nx, ny, nz = params.grid_nx, params.grid_ny, params.grid_nz
    n_cells = nx * ny * nz
    valid_arrivals = [a for a in arrivals if a.event_id in event_map and a.station_id in station_map]
    n_rays = len(valid_arrivals)

    mem = _estimate_memory(n_rays, n_cells, params.smoothness_weight, params.damping)
    logger.info(
        f"Ray matrix build: {n_rays} rays, {n_cells} cells, "
        f"est. sparse memory {mem['total_MB']} MB (G={mem['G_MB']} MB, "
        f"reg={mem['reg_MB']} MB)"
    )
    if mem["total_MB"] > MEMORY_WARNING_MB:
        logger.warning(
            f"Estimated memory {mem['total_MB']} MB exceeds safe threshold {MEMORY_WARNING_MB} MB"
        )

    if n_rays == 0:
        empty_rows = np.zeros(0, dtype=np.int32)
        empty_cols = np.zeros(0, dtype=np.int32)
        empty_data = np.zeros(0, dtype=np.float64)
        G = csr_matrix((empty_data, (empty_rows, empty_cols)), shape=(1, n_cells))
        return G, np.zeros(1), mem

    all_data_parts: list[np.ndarray] = []
    all_rows_parts: list[np.ndarray] = []
    all_cols_parts: list[np.ndarray] = []
    dt_arr = np.zeros(n_rays, dtype=np.float64)
    ray_count = 0

    src_lat_all = np.fromiter((event_map[a.event_id].latitude for a in valid_arrivals), dtype=np.float64, count=n_rays)
    src_lon_all = np.fromiter((event_map[a.event_id].longitude for a in valid_arrivals), dtype=np.float64, count=n_rays)
    src_depth_all = np.fromiter((event_map[a.event_id].depth_km for a in valid_arrivals), dtype=np.float64, count=n_rays)
    rcv_lat_all = np.fromiter((station_map[a.station_id].latitude for a in valid_arrivals), dtype=np.float64, count=n_rays)
    rcv_lon_all = np.fromiter((station_map[a.station_id].longitude for a in valid_arrivals), dtype=np.float64, count=n_rays)
    rcv_depth_all = np.fromiter((-station_map[a.station_id].elevation / 1000.0 for a in valid_arrivals), dtype=np.float64, count=n_rays)

    d_lat_all = rcv_lat_all - src_lat_all
    d_lon_all = rcv_lon_all - src_lon_all
    d_depth_all = rcv_depth_all - src_depth_all

    step_lat = params.spacing_lat * 0.25
    step_lon = params.spacing_lon * 0.25
    step_depth = params.spacing_depth * 0.25
    n_steps_arr = np.maximum(
        2,
        np.stack([
            np.abs(d_lat_all) / step_lat + 1,
            np.abs(d_lon_all) / step_lon + 1,
            np.abs(d_depth_all) / step_depth + 1,
        ], axis=0).max(axis=0).astype(np.int64),
    )
    n_steps_arr = np.minimum(n_steps_arr, 500)

    origin_lat = params.origin_lat
    origin_lon = params.origin_lon
    origin_depth = params.origin_depth
    sp_lat = params.spacing_lat
    sp_lon = params.spacing_lon
    sp_depth = params.spacing_depth

    for i in range(n_rays):
        n_steps = int(n_steps_arr[i])
        t_arr = np.linspace(0.0, 1.0, n_steps + 1, endpoint=True, dtype=np.float64)
        lats = src_lat_all[i] + t_arr * d_lat_all[i]
        lons = src_lon_all[i] + t_arr * d_lon_all[i]
        depths = src_depth_all[i] + t_arr * d_depth_all[i]

        ixs = ((lats - origin_lat) / sp_lat).astype(np.int64)
        iys = ((lons - origin_lon) / sp_lon).astype(np.int64)
        izs = ((depths - origin_depth) / sp_depth).astype(np.int64)

        valid_mask = (ixs >= 0) & (ixs < nx) & (iys >= 0) & (iys < ny) & (izs >= 0) & (izs < nz)
        ixs = ixs[valid_mask]
        iys = iys[valid_mask]
        izs = izs[valid_mask]
        t_valid = t_arr[valid_mask]

        if len(ixs) == 0:
            continue

        cell_ids = (ixs * ny + iys) * nz + izs

        changes = np.diff(cell_ids, prepend=cell_ids[0] - 1)
        seg_starts_idx = np.where(changes != 0)[0]
        seg_start_times = t_valid[seg_starts_idx]
        seg_end_times = np.concatenate([seg_start_times[1:], [t_valid[-1]]])
        fracs = seg_end_times - seg_start_times
        unique_cells = cell_ids[seg_starts_idx]
        pos_frac_mask = fracs > 0
        if not pos_frac_mask.any():
            continue
        unique_cells = unique_cells[pos_frac_mask]
        fracs = fracs[pos_frac_mask]

        n = len(fracs)
        if n == 0:
            continue
        all_data_parts.append(fracs.astype(np.float64, copy=False))
        all_cols_parts.append(unique_cells.astype(np.int32, copy=False))
        all_rows_parts.append(np.full(n, ray_count, dtype=np.int32))

        distance_km = haversine_km(src_lat_all[i], src_lon_all[i], rcv_lat_all[i], rcv_lon_all[i])
        depth_diff = abs(rcv_depth_all[i] - src_depth_all[i])
        total_dist = np.sqrt(distance_km ** 2 + depth_diff ** 2)
        vp_reference = 4500.0 / 1000.0
        observed_travel_time = total_dist / vp_reference
        arrival = valid_arrivals[i]
        event = event_map[arrival.event_id]
        if hasattr(arrival.pick_time, "total_seconds"):
            pick_offset = (arrival.pick_time - event.origin_time).total_seconds()
        else:
            pick_offset = 0.0
        dt_arr[ray_count] = pick_offset - observed_travel_time
        ray_count += 1

    dt_arr = dt_arr[:ray_count]

    if len(all_data_parts) == 0:
        empty_rows = np.zeros(0, dtype=np.int32)
        empty_cols = np.zeros(0, dtype=np.int32)
        empty_data = np.zeros(0, dtype=np.float64)
        G = csr_matrix((empty_data, (empty_rows, empty_cols)), shape=(1, n_cells))
        return G, np.zeros(1), mem

    all_data = np.concatenate(all_data_parts)
    all_rows = np.concatenate(all_rows_parts)
    all_cols = np.concatenate(all_cols_parts)
    all_data_parts.clear()
    all_rows_parts.clear()
    all_cols_parts.clear()
    gc.collect()

    G = csr_matrix(
        (all_data, (all_rows, all_cols)),
        shape=(ray_count, n_cells),
        dtype=np.float64,
    )
    G.eliminate_zeros()
    logger.info(
        f"Ray matrix built: shape={G.shape}, nnz={G.nnz}, "
        f"density={G.nnz / max(1, G.shape[0] * G.shape[1]) * 100:.4f}%"
    )
    return G, dt_arr, mem


def build_laplacian_smoother(
    nx: int, ny: int, nz: int, spacing: tuple[float, float, float]
) -> csr_matrix:
    n_cells = nx * ny * nz
    slat, slon, sdepth = spacing
    coef_x = 1.0 / (slat ** 2 + EPS)
    coef_y = 1.0 / (slon ** 2 + EPS)
    coef_z = 1.0 / (sdepth ** 2 + EPS)
    diag_val = 2.0 * (coef_x + coef_y + coef_z)

    flat_idx = np.arange(n_cells, dtype=np.int64)
    ix = (flat_idx // (ny * nz)) % nx
    iy = (flat_idx // nz) % ny
    iz = flat_idx % nz

    row_list: list[np.ndarray] = [flat_idx.copy()]
    col_list: list[np.ndarray] = [flat_idx.copy()]
    val_list: list[np.ndarray] = [np.full(n_cells, diag_val, dtype=np.float64)]

    if nx > 1:
        mask = ix > 0
        src = flat_idx[mask]
        dst = src - ny * nz
        row_list.append(src)
        col_list.append(dst)
        val_list.append(np.full(src.size, -coef_x, dtype=np.float64))

        mask = ix < nx - 1
        src = flat_idx[mask]
        dst = src + ny * nz
        row_list.append(src)
        col_list.append(dst)
        val_list.append(np.full(src.size, -coef_x, dtype=np.float64))

    if ny > 1:
        mask = iy > 0
        src = flat_idx[mask]
        dst = src - nz
        row_list.append(src)
        col_list.append(dst)
        val_list.append(np.full(src.size, -coef_y, dtype=np.float64))

        mask = iy < ny - 1
        src = flat_idx[mask]
        dst = src + nz
        row_list.append(src)
        col_list.append(dst)
        val_list.append(np.full(src.size, -coef_y, dtype=np.float64))

    if nz > 1:
        mask = iz > 0
        src = flat_idx[mask]
        dst = src - 1
        row_list.append(src)
        col_list.append(dst)
        val_list.append(np.full(src.size, -coef_z, dtype=np.float64))

        mask = iz < nz - 1
        src = flat_idx[mask]
        dst = src + 1
        row_list.append(src)
        col_list.append(dst)
        val_list.append(np.full(src.size, -coef_z, dtype=np.float64))

    all_rows = np.concatenate(row_list).astype(np.int32, copy=False)
    all_cols = np.concatenate(col_list).astype(np.int32, copy=False)
    all_vals = np.concatenate(val_list)
    row_list.clear()
    col_list.clear()
    val_list.clear()
    gc.collect()

    L = csr_matrix(
        (all_vals, (all_rows, all_cols)),
        shape=(n_cells, n_cells),
        dtype=np.float64,
    )
    L.eliminate_zeros()
    row_norm = np.abs(L).sum(axis=1).A1
    row_norm = np.where(row_norm > 0, row_norm, 1.0)
    inv_sqrt_norm = 1.0 / np.sqrt(row_norm)
    scale = diags(inv_sqrt_norm, format="csr")
    L_norm = scale @ L @ scale
    del all_rows, all_cols, all_vals, scale
    gc.collect()
    logger.info(
        f"Laplacian smoother L: shape={L_norm.shape}, nnz={L_norm.nnz}, "
        f"density={L_norm.nnz / max(1, n_cells * n_cells) * 100:.4f}%"
    )
    return L_norm


def _tikhonov_augment(
    G: csr_matrix, dt: np.ndarray,
    damping: float, smoothness_weight: float,
    nx: int, ny: int, nz: int,
    spacing: tuple[float, float, float],
) -> tuple[csr_matrix, np.ndarray]:
    n_rays, n_cells = G.shape
    blocks: list[csr_matrix] = [G]
    rhs_parts: list[np.ndarray] = [dt]

    if smoothness_weight > 0:
        L = build_laplacian_smoother(nx, ny, nz, spacing)
        sqrt_smooth = np.sqrt(smoothness_weight)
        smooth_block = sqrt_smooth * L
        blocks.append(smooth_block)
        rhs_parts.append(np.zeros(n_cells, dtype=np.float64))
        del L

    if damping > 0:
        damp_vec = np.full(n_cells, np.sqrt(damping), dtype=np.float64)
        damp_block = diags(damp_vec, format="csr")
        blocks.append(damp_block)
        rhs_parts.append(np.zeros(n_cells, dtype=np.float64))

    G_aug = vstack(blocks, format="csr")
    dt_aug = np.concatenate(rhs_parts)
    del blocks
    del rhs_parts
    gc.collect()
    logger.info(
        f"Tikhonov augmented: G_aug shape={G_aug.shape}, nnz={G_aug.nnz}, "
        f"density={G_aug.nnz / max(1, G_aug.shape[0] * G_aug.shape[1]) * 100:.4f}%"
    )
    return G_aug, dt_aug


def run_lsqr_tomography(
    G: csr_matrix,
    dt: np.ndarray,
    damping: float = 0.05,
    smoothness_weight: float = 0.1,
    max_iter: int = 50,
    nx: int = 20,
    ny: int = 20,
    nz: int = 20,
    spacing: tuple[float, float, float] = (0.01, 0.01, 0.1),
    atol: float = 1e-8,
    btol: float = 1e-8,
    conlim: float = 1e8,
    show: bool = False,
) -> tuple[np.ndarray, float, int, list[float]]:
    n_rays, n_cells = G.shape
    logger.info(
        f"LSQR start: rays={n_rays}, cells={n_cells}, "
        f"damp={damping}, smooth={smoothness_weight}, max_iter={max_iter}"
    )

    G_aug, dt_aug = _tikhonov_augment(
        G, dt, damping, smoothness_weight, nx, ny, nz, spacing
    )

    n_aug = G_aug.shape[0]
    zero_model = np.zeros(n_cells, dtype=np.float64)
    initial_residual = float(np.linalg.norm(G @ zero_model - dt))
    initial_residual = max(initial_residual, EPS)

    step = max(1, max_iter // 25)
    convergence: list[float] = []

    def _record():
        m_step = _inner_result[0]
        res = float(np.linalg.norm(G @ m_step - dt)) / initial_residual
        convergence.append(res)

    _inner_result = (zero_model, 0, 0, 0, 0, 0, 0, 0)

    for checkpoint in range(step, max_iter + 1, step):
        result = lsqr(
            G_aug, dt_aug,
            damp=0.0, atol=atol, btol=btol, conlim=conlim,
            iter_lim=checkpoint, show=show,
        )
        _inner_result = result
        _record()
        if len(convergence) >= 3 and convergence[-1] > 0 and convergence[-2] > 0:
            rel_change = abs(convergence[-1] - convergence[-2]) / max(convergence[-2], EPS)
            if rel_change < 1e-5:
                logger.info(f"LSQR converged early at iter {checkpoint}, rel_change={rel_change:.3e}")
                break

    final_result = lsqr(
        G_aug, dt_aug,
        damp=0.0, atol=atol, btol=btol, conlim=conlim,
        iter_lim=max_iter, show=show,
    )
    model = final_result[0]
    iterations = final_result[2]
    residual_norm = float(final_result[3])
    rms = float(np.linalg.norm(G @ model - dt) / max(n_rays, 1))

    del G_aug, dt_aug
    gc.collect()

    logger.info(
        f"LSQR done: iterations={iterations}, final_rms={rms:.6e}, "
        f"residual_norm={residual_norm:.4e}, convergence_len={len(convergence)}"
    )
    return model, rms, iterations, convergence


def interpolate_velocity(model_1d: np.ndarray, grid_shape: tuple[int, int, int]) -> np.ndarray:
    expected_size = grid_shape[0] * grid_shape[1] * grid_shape[2]
    if len(model_1d) < expected_size:
        model_1d = np.pad(model_1d, (0, expected_size - len(model_1d)))
    elif len(model_1d) > expected_size:
        model_1d = model_1d[:expected_size]
    slowness_3d = model_1d.reshape(grid_shape)
    vp_ref = 4500.0
    slowness_3d = slowness_3d + 1.0 / vp_ref
    velocity_3d = 1.0 / slowness_3d
    velocity_3d = np.clip(velocity_3d, 1000.0, 8000.0)
    return velocity_3d


def extract_isosurface(
    velocity_3d: np.ndarray,
    iso_level: float = 4500.0,
) -> tuple[list[list[float]], list[list[int]]]:
    try:
        verts, faces, _, _ = marching_cubes(velocity_3d, level=iso_level)
        vertices = verts.tolist()
        faces_list = faces.tolist()
        return vertices, faces_list
    except (ValueError, RuntimeError):
        return [], []
