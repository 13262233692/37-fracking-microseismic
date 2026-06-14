from __future__ import annotations
import math
import numpy as np
from models import PArrival, Station, MicroseismicEvent, FocalMechanism


DEG2RAD = math.pi / 180.0
RAD2DEG = 180.0 / math.pi


def _azimuth_deg(src_lat: float, src_lon: float, rcv_lat: float, rcv_lon: float) -> float:
    slat = src_lat * DEG2RAD
    clat = rcv_lat * DEG2RAD
    dlon = (rcv_lon - src_lon) * DEG2RAD
    x = math.sin(dlon) * math.cos(clat)
    y = math.cos(slat) * math.sin(clat) - math.sin(slat) * math.cos(clat) * math.cos(dlon)
    azi = math.atan2(x, y) * RAD2DEG
    if azi < 0:
        azi += 360.0
    return azi


def _takeoff_angle_deg(src_depth_km: float, rcv_elev_m: float, hdist_km: float, vp: float = 6.0) -> float:
    z_src = max(src_depth_km, 0.0)
    z_rcv = -rcv_elev_m / 1000.0
    dz = z_src - z_rcv
    horiz = max(hdist_km, 0.001)
    takeoff = math.atan2(horiz, dz) * RAD2DEG
    return float(max(0.0, min(takeoff, 90.0)))


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = (lat2 - lat1) * DEG2RAD
    dlon = (lon2 - lon1) * DEG2RAD
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1 * DEG2RAD) * math.cos(lat2 * DEG2RAD) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def compute_station_angles(event: MicroseismicEvent, station: Station) -> tuple[float, float]:
    hdist = _haversine_km(event.latitude, event.longitude, station.latitude, station.longitude)
    azi = _azimuth_deg(event.latitude, event.longitude, station.latitude, station.longitude)
    takeoff = _takeoff_angle_deg(event.depth_km, station.elevation, hdist)
    return azi, takeoff


def _strike_dip_rake_to_normal_shear(strike_deg: float, dip_deg: float, rake_deg: float):
    strike = strike_deg * DEG2RAD
    dip = dip_deg * DEG2RAD
    rake = rake_deg * DEG2RAD

    normal = np.array([
        -math.sin(dip) * math.sin(strike),
         math.sin(dip) * math.cos(strike),
        -math.cos(dip),
    ])
    s_sin = math.sin(rake) * math.cos(dip)
    s_cos_cos = math.cos(rake) * math.cos(strike)
    s_cos_sin = math.cos(rake) * math.sin(strike)
    s_dip_sin = math.sin(dip) * math.sin(rake)

    shear = np.array([
         s_cos_cos * math.cos(strike) + s_dip_sin * math.sin(strike) - s_sin * math.sin(strike),
        -s_cos_sin * math.sin(strike) + s_dip_sin * math.cos(strike) + s_sin * math.cos(strike),
        -math.cos(rake) * math.sin(dip),
    ])
    nrm = np.linalg.norm(shear)
    if nrm > 1e-12:
        shear = shear / nrm
    return normal, shear


def _p_wave_radiation(normal: np.ndarray, shear: np.ndarray, takeoff_deg: float, azimuth_deg: float) -> float:
    theta = takeoff_deg * DEG2RAD
    phi = azimuth_deg * DEG2RAD
    r = np.array([
        math.sin(theta) * math.cos(phi),
        math.sin(theta) * math.sin(phi),
        math.cos(theta),
    ])
    rn = float(np.dot(r, normal))
    rs = float(np.dot(r, shear))
    return 2.0 * rn * rs


def _predict_polarity(strike: float, dip: float, rake: float, takeoff: float, azimuth: float) -> int:
    normal, shear = _strike_dip_rake_to_normal_shear(strike, dip, rake)
    amp = _p_wave_radiation(normal, shear, takeoff, azimuth)
    if amp > 0:
        return 1
    elif amp < 0:
        return -1
    return 0


def _aux_plane(strike: float, dip: float, rake: float) -> tuple[float, float, float]:
    n1, s1 = _strike_dip_rake_to_normal_shear(strike, dip, rake)
    n2 = s1
    s2 = -n1
    dip_aux = math.acos(max(-1.0, min(1.0, -n2[2]))) * RAD2DEG
    if abs(dip_aux) < 1e-3:
        dip_aux = 0.0
    elif abs(dip_aux - 180.0) < 1e-3:
        dip_aux = 0.0
    if dip_aux > 90.0:
        dip_aux = 180.0 - dip_aux
        n2 = -n2
        s2 = -s2
    strike_aux = math.atan2(n2[0], -n2[1]) * RAD2DEG
    if strike_aux < 0:
        strike_aux += 360.0
    s2h = np.array([s2[0], s2[1], 0.0])
    n2h = np.array([n2[0], n2[1], 0.0])
    nh_norm = np.linalg.norm(n2h)
    if nh_norm < 1e-9:
        rake_aux = 0.0 if s2[2] >= 0 else 180.0
    else:
        along_strike = n2h / nh_norm
        along_dip_h = np.cross(np.array([0, 0, 1]), along_strike)
        if along_dip_h[0] * s2[0] + along_dip_h[1] * s2[1] < 0:
            along_dip_h = -along_dip_h
        rake_aux = math.atan2(s2[2], s2[0] * along_strike[0] + s2[1] * along_strike[1]) * RAD2DEG
    if rake_aux < -180.0:
        rake_aux += 360.0
    elif rake_aux > 180.0:
        rake_aux -= 360.0
    return float(strike_aux), float(dip_aux), float(rake_aux)


def solve_focal_mechanism_grid_search(
    event: MicroseismicEvent,
    arrivals: list[PArrival],
    stations: list[Station],
) -> FocalMechanism | None:
    station_map = {s.id: s for s in stations}
    obs = []
    for a in arrivals:
        if event.id is not None and a.event_id is not None and a.event_id != event.id:
            continue
        if a.polarity == 0:
            continue
        st = station_map.get(a.station_id)
        if st is None:
            continue
        azi, takeoff = compute_station_angles(event, st)
        obs.append((azi, takeoff, int(a.polarity)))

    if len(obs) < 4:
        return None

    strike_grid = np.arange(0.0, 360.0, 10.0, dtype=np.float64)
    dip_grid = np.arange(5.0, 91.0, 5.0, dtype=np.float64)
    rake_grid = np.arange(-180.0, 181.0, 10.0, dtype=np.float64)

    best_misfit = float("inf")
    best_sdr = (0.0, 45.0, 0.0)

    for stk in strike_grid:
        for dp in dip_grid:
            for rk in rake_grid:
                misfit = 0
                for azi, takeoff, pol in obs:
                    pred = _predict_polarity(float(stk), float(dp), float(rk), takeoff, azi)
                    if pred == 0:
                        misfit += 1
                    elif pred != pol:
                        misfit += 2
                if misfit < best_misfit:
                    best_misfit = misfit
                    best_sdr = (float(stk), float(dp), float(rk))

    best_strike, best_dip, best_rake = best_sdr
    for ref_step in [(5.0, 2.5, 5.0), (1.0, 1.0, 2.0)]:
        sst, sdp, srk = ref_step
        best_local = best_sdr
        best_local_misfit = best_misfit
        for dstk in np.arange(-2 * sst, 2 * sst + 1e-9, sst):
            for ddp in np.arange(-2 * sdp, 2 * sdp + 1e-9, sdp):
                for drk in np.arange(-2 * srk, 2 * srk + 1e-9, srk):
                    stk = (best_strike + dstk) % 360.0
                    dp = max(1.0, min(89.0, best_dip + ddp))
                    rk = best_rake + drk
                    if rk < -180.0:
                        rk += 360.0
                    elif rk > 180.0:
                        rk -= 360.0
                    misfit = 0
                    for azi, takeoff, pol in obs:
                        pred = _predict_polarity(stk, dp, rk, takeoff, azi)
                        if pred == 0:
                            misfit += 1
                        elif pred != pol:
                            misfit += 2
                    if misfit < best_local_misfit:
                        best_local_misfit = misfit
                        best_local = (stk, dp, rk)
        best_strike, best_dip, best_rake = best_local
        best_misfit = best_local_misfit

    strike_aux, dip_aux, rake_aux = _aux_plane(best_strike, best_dip, best_rake)
    misfit_rate = float(best_misfit) / max(1, len(obs))
    svg = render_beachball_svg(best_strike, best_dip, best_rake)

    return FocalMechanism(
        event_id=int(event.id) if event.id is not None else 0,
        strike=float(best_strike),
        dip=float(best_dip),
        rake=float(best_rake),
        strike_aux=float(strike_aux),
        dip_aux=float(dip_aux),
        rake_aux=float(rake_aux),
        polarity_misfit=misfit_rate,
        used_polarities=len(obs),
        beachball_svg=svg,
    )


def _equal_area_project(theta_deg: float, phi_deg: float, cx: float, cy: float, R: float) -> tuple[float, float]:
    theta = theta_deg * DEG2RAD
    phi = phi_deg * DEG2RAD
    if theta > 90.0 * DEG2RAD:
        theta = math.pi - theta
        phi += math.pi
    r = 2.0 * R * math.sin(theta / 2.0)
    x = cx + r * math.sin(phi)
    y = cy - r * math.cos(phi)
    return x, y


def _fault_plane_polyline(strike_deg: float, dip_deg: float, cx: float, cy: float, R: float) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    strike = strike_deg * DEG2RAD
    dip = dip_deg * DEG2RAD
    n_pts = 361
    for i in range(n_pts):
        alpha = -math.pi + (2 * math.pi * i) / (n_pts - 1)
        x_s = math.cos(alpha)
        y_s = math.sin(alpha)
        nx = x_s * math.cos(strike) - y_s * math.sin(strike) * math.cos(dip)
        ny = x_s * math.sin(strike) + y_s * math.cos(strike) * math.cos(dip)
        nz = y_s * math.sin(dip)
        if nz > 1e-9:
            continue
        theta = math.acos(max(-1.0, min(1.0, nz))) * RAD2DEG
        phi = math.atan2(ny, nx) * RAD2DEG
        if phi < 0:
            phi += 360.0
        px, py = _equal_area_project(theta, phi, cx, cy, R)
        if not pts or abs(pts[-1][0] - px) + abs(pts[-1][1] - py) > 1e-6:
            pts.append((px, py))
    return pts


def _compress_region_polygons(
    strike: float, dip: float, rake: float,
    cx: float, cy: float, R: float,
) -> list[list[tuple[float, float]]]:
    polygons: list[list[tuple[float, float]]] = []
    n_az = 120
    n_to = 40
    grid = np.zeros((n_az, n_to), dtype=np.int8)
    for i in range(n_az):
        az = 360.0 * i / n_az
        for j in range(n_to):
            to = 90.0 * (j + 0.5) / n_to
            grid[i, j] = _predict_polarity(strike, dip, rake, to, az)

    def _cell_center(i, j):
        az = 360.0 * i / n_az
        to = 90.0 * (j + 0.5) / n_to
        return _equal_area_project(to, az, cx, cy, R)

    visited = np.zeros_like(grid, dtype=bool)
    for i0 in range(n_az):
        for j0 in range(n_to):
            if visited[i0, j0] or grid[i0, j0] != 1:
                continue
            stack = [(i0, j0)]
            visited[i0, j0] = True
            component = []
            while stack:
                i, j = stack.pop()
                component.append((i, j))
                for di, dj in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                    ni = (i + di) % n_az
                    nj = j + dj
                    if 0 <= nj < n_to and not visited[ni, nj] and grid[ni, nj] == 1:
                        visited[ni, nj] = True
                        stack.append((ni, nj))
            if len(component) < 4:
                continue
            component_set = set(component)
            boundary_set: set[tuple[int, int]] = set()
            for (i, j) in component:
                is_boundary = False
                for di, dj in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                    ni = (i + di) % n_az
                    nj = j + dj
                    if nj < 0 or nj >= n_to:
                        is_boundary = True
                        break
                    if (ni, nj) not in component_set:
                        is_boundary = True
                        break
                if is_boundary:
                    boundary_set.add((i, j))
            if not boundary_set:
                continue
            boundary_list = list(boundary_set)
            xs = [_cell_center(i, j)[0] for (i, j) in boundary_list]
            ys = [_cell_center(i, j)[1] for (i, j) in boundary_list]
            cx_comp = float(np.mean(xs))
            cy_comp = float(np.mean(ys))
            def _angle(ij):
                px, py = _cell_center(*ij)
                return math.atan2(py - cy_comp, px - cx_comp)
            boundary_list.sort(key=_angle)
            step = max(1, len(boundary_list) // 120)
            sampled = boundary_list[::step]
            hull = [_cell_center(i, j) for (i, j) in sampled]
            polygons.append(hull)
    return polygons


def render_beachball_svg(
    strike: float, dip: float, rake: float,
    size: int = 120,
    compress_color: str = "#FF3D00",
    dilate_color: str = "#00E5FF",
    line_color: str = "#E8ECF4",
    bg_color: str = "#141926",
) -> str:
    R = size / 2.0 - 2
    cx = size / 2.0
    cy = size / 2.0

    strike_aux, dip_aux, _ = _aux_plane(strike, dip, rake)

    poly_p = _fault_plane_polyline(strike, dip, cx, cy, R)
    poly_aux = _fault_plane_polyline(strike_aux, dip_aux, cx, cy, R)

    compress_polys = _compress_region_polygons(strike, dip, rake, cx, cy, R)

    def _fmt(pt: tuple[float, float]) -> str:
        return f"{pt[0]:.3f},{pt[1]:.3f}"

    circle_cx = f"{cx:.3f}"
    circle_cy = f"{cy:.3f}"
    circle_r = f"{R:.3f}"

    poly_p_str = " ".join(_fmt(p) for p in poly_p) if poly_p else ""
    poly_aux_str = " ".join(_fmt(p) for p in poly_aux) if poly_aux else ""

    clip_id = f"bbclip_{abs(hash((strike, dip, rake))) % 100000}"

    parts = [
        f'<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">',
        f'<defs><clipPath id="{clip_id}"><circle cx="{circle_cx}" cy="{circle_cy}" r="{circle_r}"/></clipPath></defs>',
        f'<rect x="0" y="0" width="{size}" height="{size}" fill="{bg_color}"/>',
        f'<circle cx="{circle_cx}" cy="{circle_cy}" r="{circle_r}" fill="{dilate_color}" stroke="{line_color}" stroke-width="1.2"/>',
    ]

    for poly in compress_polys:
        if len(poly) < 3:
            continue
        ps = " ".join(_fmt(p) for p in poly)
        parts.append(f'<path d="M{ps} Z" fill="{compress_color}" clip-path="url(#{clip_id})" opacity="0.98"/>')

    if poly_p_str:
        parts.append(f'<polyline points="{poly_p_str}" fill="none" stroke="{line_color}" stroke-width="1.4" clip-path="url(#{clip_id})"/>')
    if poly_aux_str:
        parts.append(f'<polyline points="{poly_aux_str}" fill="none" stroke="{line_color}" stroke-width="1.4" stroke-dasharray="3,2" clip-path="url(#{clip_id})"/>')

    parts.append(f'<circle cx="{circle_cx}" cy="{circle_cy}" r="{circle_r}" fill="none" stroke="{line_color}" stroke-width="1.4"/>')
    parts.append(f'</svg>')
    return "".join(parts)
