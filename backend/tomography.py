from __future__ import annotations
import numpy as np
from scipy.sparse import lil_matrix, csr_matrix, vstack, diags
from scipy.sparse.linalg import lsqr
from skimage.measure import marching_cubes
from models import PArrival, Station, MicroseismicEvent, TomographyParams


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = np.radians(lat2 - lat1)
    dlon = np.radians(lon2 - lon1)
    a = np.sin(dlat / 2) ** 2 + np.cos(np.radians(lat1)) * np.cos(np.radians(lat2)) * np.sin(dlon / 2) ** 2
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
    return R * c


def build_ray_matrix(
    arrivals: list[PArrival],
    stations: list[Station],
    events: list[MicroseismicEvent],
    params: TomographyParams,
) -> tuple[csr_matrix, np.ndarray]:
    station_map = {s.id: s for s in stations}
    event_map = {e.id: e for e in events}
    nx, ny, nz = params.grid_nx, params.grid_ny, params.grid_nz
    n_cells = nx * ny * nz
    valid_arrivals = [a for a in arrivals if a.event_id in event_map and a.station_id in station_map]
    n_rays = len(valid_arrivals)
    if n_rays == 0:
        G = lil_matrix((1, n_cells))
        dt = np.zeros(1)
        return csr_matrix(G), dt
    G = lil_matrix((n_rays, n_cells), dtype=np.float64)
    dt = np.zeros(n_rays)
    for i, arrival in enumerate(valid_arrivals):
        event = event_map[arrival.event_id]
        station = station_map[arrival.station_id]
        src_lat = event.latitude
        src_lon = event.longitude
        src_depth = event.depth_km
        rcv_lat = station.latitude
        rcv_lon = station.longitude
        rcv_depth = -station.elevation / 1000.0
        n_steps = 50
        cell_hits: dict[int, float] = {}
        for s in range(n_steps):
            t = s / n_steps
            lat = src_lat + t * (rcv_lat - src_lat)
            lon = src_lon + t * (rcv_lon - src_lon)
            depth = src_depth + t * (rcv_depth - src_depth)
            ix = int((lat - params.origin_lat) / params.spacing_lat)
            iy = int((lon - params.origin_lon) / params.spacing_lon)
            iz = int((depth - params.origin_depth) / params.spacing_depth)
            ix = max(0, min(ix, nx - 1))
            iy = max(0, min(iy, ny - 1))
            iz = max(0, min(iz, nz - 1))
            cell_idx = ix * ny * nz + iy * nz + iz
            cell_hits[cell_idx] = cell_hits.get(cell_idx, 0.0) + 1.0 / n_steps
        for cell_idx, frac in cell_hits.items():
            G[i, cell_idx] = frac
        distance_km = haversine_km(src_lat, src_lon, rcv_lat, rcv_lon)
        depth_diff = abs(rcv_depth - src_depth)
        total_dist = np.sqrt(distance_km ** 2 + depth_diff ** 2)
        vp_reference = 4500.0 / 1000.0
        observed_travel_time = total_dist / vp_reference
        if hasattr(arrival.pick_time, "total_seconds"):
            pick_offset = (arrival.pick_time - event.origin_time).total_seconds()
        else:
            pick_offset = 0.0
        dt[i] = pick_offset - observed_travel_time
    return csr_matrix(G), dt


def run_lsqr_tomography(
    G: csr_matrix,
    dt: np.ndarray,
    damping: float = 0.05,
    max_iter: int = 50,
) -> tuple[np.ndarray, float, int, list[float]]:
    n_model = G.shape[1]
    n_rays = G.shape[0]
    damp_diag = damping * np.ones(n_model)
    damping_matrix = diags(damp_diag, 0, format="csr")
    G_damped = vstack([G, damping_matrix], format="csr")
    dt_damped = np.concatenate([dt, np.zeros(n_model)])
    convergence: list[float] = []
    initial_residual = max(np.linalg.norm(G @ np.zeros(n_model) - dt), 1e-10)
    step = max(1, max_iter // 20)
    for it in range(1, max_iter + 1, step):
        result = lsqr(G_damped, dt_damped, iter_lim=it, show=False)
        model = result[0]
        residual = float(np.linalg.norm(G @ model - dt))
        convergence.append(residual / initial_residual)
    result = lsqr(G_damped, dt_damped, iter_lim=max_iter, show=False)
    model = result[0]
    iterations = result[2]
    rms = float(np.linalg.norm(G @ model - dt) / max(n_rays, 1))
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
