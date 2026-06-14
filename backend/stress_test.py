from __future__ import annotations
import sys
import tracemalloc
import numpy as np
from datetime import datetime, timedelta
import gc

sys.path.insert(0, r"d:\SOLO-11\37-fracking-microseismic\backend")

from models import PArrival, Station, MicroseismicEvent, TomographyParams
from tomography import build_ray_matrix, run_lsqr_tomography, _estimate_memory


def make_synthetic_scene(n_rays: int, grid_nx: int, grid_ny: int, grid_nz: int):
    origin_lat = 29.5
    origin_lon = 104.5
    origin_depth = 0.0
    spacing_lat = 0.005
    spacing_lon = 0.005
    spacing_depth = 0.05
    extent_lat = (grid_nx - 1) * spacing_lat
    extent_lon = (grid_ny - 1) * spacing_lon
    extent_depth = (grid_nz - 1) * spacing_depth

    n_stations = 12
    stations = []
    for i in range(n_stations):
        angle = 2 * np.pi * i / n_stations
        r = 0.3
        stations.append(
            Station(
                id=f"STA{i:02d}",
                name=f"Station {i+1}",
                latitude=origin_lat + extent_lat / 2 + r * np.cos(angle),
                longitude=origin_lon + extent_lon / 2 + r * np.sin(angle),
                elevation=500.0 + i * 10.0,
                status="online",
            )
        )

    events = []
    np.random.seed(42)
    for i in range(max(1, n_rays // n_stations)):
        events.append(
            MicroseismicEvent(
                id=i + 1,
                origin_time=datetime(2026, 6, 14, 8, 0, 0) + timedelta(seconds=i * 60),
                latitude=origin_lat + np.random.uniform(0.0, extent_lat),
                longitude=origin_lon + np.random.uniform(0.0, extent_lon),
                depth_km=origin_depth + np.random.uniform(0.0, extent_depth),
                magnitude=float(np.random.uniform(-2.0, 2.0)),
                num_arrivals=n_stations,
            )
        )

    arrivals = []
    arr_id = 1
    for ev in events:
        for sta in stations:
            r_lat = ev.latitude - sta.latitude
            r_lon = ev.longitude - sta.longitude
            r_z = ev.depth_km + sta.elevation / 1000.0
            dist = np.sqrt(r_lat * r_lat * (111 ** 2) + r_lon * r_lon * (95 ** 2) + r_z * r_z)
            vp = 4.5
            t = dist / vp
            noise = np.random.normal(0, 0.003)
            pick = ev.origin_time + timedelta(seconds=float(t + noise))
            arrivals.append(
                PArrival(
                    id=arr_id,
                    station_id=sta.id,
                    event_id=ev.id,
                    pick_time=pick,
                    snr=float(np.random.uniform(2.0, 80.0)),
                    sta_lta_ratio=float(np.random.uniform(3.0, 15.0)),
                    confidence=float(np.random.uniform(0.5, 0.99)),
                )
            )
            arr_id += 1
            if arr_id > n_rays:
                break
        if arr_id > n_rays:
            break

    params = TomographyParams(
        damping=0.05,
        smoothness_weight=0.1,
        max_iter=60,
        grid_nx=grid_nx,
        grid_ny=grid_ny,
        grid_nz=grid_nz,
        origin_lat=origin_lat,
        origin_lon=origin_lon,
        origin_depth=origin_depth,
        spacing_lat=spacing_lat,
        spacing_lon=spacing_lon,
        spacing_depth=spacing_depth,
    )
    return arrivals, stations, events, params


def test_one(name: str, nx: int, ny: int, nz: int, n_rays: int):
    n_cells = nx * ny * nz
    print(f"\n--- {name}: grid={nx}x{ny}x{nz}={n_cells:,} cells, rays={n_rays:,}")
    tracemalloc.start()
    try:
        arrivals, stations, events, params = make_synthetic_scene(n_rays, nx, ny, nz)
        mem_est = _estimate_memory(n_rays, n_cells, params.smoothness_weight, params.damping)
        print(f"  memory estimate: {mem_est['total_MB']:.2f} MB (G={mem_est['G_MB']:.2f} + reg={mem_est['reg_MB']:.2f})")

        G, dt, _ = build_ray_matrix(arrivals, stations, events, params)
        print(f"  Ray matrix: shape={G.shape}, nnz={G.nnz:,}, density={G.nnz/(G.shape[0]*G.shape[1])*100:.4f}%")

        _, current_mem = tracemalloc.get_traced_memory()
        print(f"  Current mem (after G): {current_mem/1024**2:.2f} MB")

        spacing = (params.spacing_lat, params.spacing_lon, params.spacing_depth)
        model, rms, iterations, convergence = run_lsqr_tomography(
            G, dt,
            damping=params.damping,
            smoothness_weight=params.smoothness_weight,
            max_iter=params.max_iter,
            nx=params.grid_nx,
            ny=params.grid_ny,
            nz=params.grid_nz,
            spacing=spacing,
        )

        _, peak_mem = tracemalloc.get_traced_memory()
        print(f"  Peak mem: {peak_mem/1024**2:.2f} MB")
        print(f"  Result: iterations={iterations}, RMS={rms:.6e}")
        print(f"  Convergence: len={len(convergence)} first={convergence[0]:.4f} last={convergence[-1]:.4f}")

        if len(convergence) < 2:
            print("  [FAIL] Convergence too short")
            return False
        if convergence[-1] > convergence[0]:
            print(f"  [FAIL] Residual blew up ({convergence[0]:.4f} -> {convergence[-1]:.4f})")
            return False
        if convergence[-1] / max(convergence[0], 1e-9) > 0.5:
            print(f"  [WARN] Did not converge enough ({convergence[-1]:.4f}/{convergence[0]:.4f})")
        else:
            print("  [PASS] Convergence good!")
        return True
    except MemoryError as e:
        _, peak_mem = tracemalloc.get_traced_memory()
        print(f"  [OOM CRASH] Peak={peak_mem/1024**2:.2f}MB: {e}")
        return False
    except Exception as e:
        _, peak_mem = tracemalloc.get_traced_memory()
        import traceback
        traceback.print_exc()
        print(f"  [ERROR] Peak={peak_mem/1024**2:.2f}MB: {e.__class__.__name__}: {e}")
        return False
    finally:
        tracemalloc.stop()
        gc.collect()


def main():
    print("=" * 80)
    print("PRESSURE TEST: Tikhonov Regularization + Sparse Ray Matrix")
    print("=" * 80)

    test_configs = [
        ("TINY (8k cells)", 20, 20, 20, 120),
        ("SMALL (64k cells)", 40, 40, 40, 480),
        ("MEDIUM (216k cells)", 60, 60, 60, 960),
        ("LARGE (~1M cells)", 100, 100, 100, 1500),
    ]

    all_pass = True
    for name, nx, ny, nz, n_rays in test_configs:
        if not test_one(name, nx, ny, nz, n_rays):
            all_pass = False

    print("\n" + "=" * 80)
    print("OVERALL:", "ALL PASS" if all_pass else "HAS FAILURES")
    print("=" * 80)
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
