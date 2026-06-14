from __future__ import annotations
import asyncio
import gc
import logging
import numpy as np
from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Query, HTTPException
from models import (
    Station, WaveformSegment, PArrival, MicroseismicEvent,
    TomographyResult, FilterParams, TomographyParams,
    TomographyProgress, IsosurfaceData, FocalMechanism,
)
import database as db
from simulator import ring_buffer, simulator
from tomography import (
    build_ray_matrix, run_lsqr_tomography,
    interpolate_velocity, extract_isosurface,
)
from focal_mechanism import solve_focal_mechanism_grid_search, render_beachball_svg

router = APIRouter(prefix="/api")

logger = logging.getLogger(__name__)

_tomo_running = False
_tomo_task: Optional[asyncio.Task] = None
_tomo_progress_callback = None


@router.get("/stations", response_model=list[Station])
async def list_stations():
    return await db.get_stations()


@router.get("/waveform", response_model=list[WaveformSegment])
async def get_waveform(
    station_id: str = Query(...),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    channel: str = Query("Z"),
):
    start_dt = datetime.fromisoformat(start) if start else None
    end_dt = datetime.fromisoformat(end) if end else None
    channels = [channel] if channel != "ALL" else ["Z", "N", "E"]
    segments = []
    for ch in channels:
        result = ring_buffer.read(station_id, ch, start_dt, end_dt)
        if result is not None:
            data, actual_start = result
            end_time = actual_start + timedelta(seconds=len(data) / ring_buffer.fs)
            segments.append(
                WaveformSegment(
                    station_id=station_id,
                    channel=ch,
                    start_time=actual_start,
                    end_time=end_time,
                    sampling_rate=ring_buffer.fs,
                    data=data.tolist(),
                )
            )
    return segments


@router.get("/arrivals", response_model=list[PArrival])
async def get_arrivals(
    station_id: Optional[str] = Query(None),
    event_id: Optional[int] = Query(None),
):
    return await db.get_arrivals(station_id, event_id)


@router.get("/events", response_model=list[MicroseismicEvent])
async def get_events(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    min_magnitude: Optional[float] = Query(None),
):
    return await db.get_events(start, end, min_magnitude)


@router.get("/events/{event_id}/focal", response_model=Optional[FocalMechanism])
async def get_event_focal_mechanism(event_id: int, recompute: bool = False):
    event = await db.get_event(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")
    cached = await db.get_event_focal(event_id)
    if not recompute and cached is not None:
        return cached
    arrivals = await db.get_arrivals(event_id=event_id)
    stations = await db.get_stations()
    if len([a for a in arrivals if getattr(a, 'polarity', 0) != 0]) < 4:
        if cached is not None:
            return cached
        raise HTTPException(status_code=400, detail="Insufficient polarities for focal mechanism (need >=4)")
    focal = solve_focal_mechanism_grid_search(event, arrivals, stations)
    if focal is None:
        if cached is not None:
            return cached
        raise HTTPException(status_code=500, detail="Focal mechanism grid search failed")
    await db.update_event_focal(event_id, focal)
    return focal


@router.get("/focal", response_model=list[dict])
async def list_all_focal_mechanisms():
    focal_pairs = await db.get_all_focal()
    result = []
    for event_id, fm in focal_pairs:
        event = await db.get_event(event_id)
        if event is None:
            continue
        result.append({
            "event_id": event_id,
            "latitude": event.latitude,
            "longitude": event.longitude,
            "depth_km": event.depth_km,
            "magnitude": event.magnitude,
            "origin_time": event.origin_time.isoformat(),
            "focal": fm,
        })
    return result


@router.get("/events/{event_id}/focal/beachball")
async def get_event_beachball_svg(event_id: int):
    from fastapi.responses import Response
    focal = await db.get_event_focal(event_id)
    if focal is None:
        event = await db.get_event(event_id)
        if event is None:
            raise HTTPException(status_code=404, detail="Event not found")
        arrivals = await db.get_arrivals(event_id=event_id)
        stations = await db.get_stations()
        focal = solve_focal_mechanism_grid_search(event, arrivals, stations)
        if focal is None:
            raise HTTPException(status_code=500, detail="Focal mechanism grid search failed")
        await db.update_event_focal(event_id, focal)
    svg = focal.beachball_svg if focal.beachball_svg else render_beachball_svg(
        focal.strike, focal.dip, focal.rake, size=200,
    )
    return Response(content=svg, media_type="image/svg+xml")


@router.get("/tomography/latest", response_model=TomographyResult)
async def get_latest_tomography():
    result = await db.get_latest_tomography_result()
    if result is None:
        raise HTTPException(status_code=404, detail="No tomography results found")
    return result


@router.get("/tomography/{tomo_id}", response_model=TomographyResult)
async def get_tomography(tomo_id: int):
    result = await db.get_tomography_result(tomo_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Tomography result not found")
    return result


@router.post("/filter/config")
async def update_filter_config(params: FilterParams):
    simulator.filter_params = params
    return {"status": "ok", "params": params.model_dump()}


@router.post("/tomography/start")
async def start_tomography(params: TomographyParams):
    global _tomo_running, _tomo_task
    if _tomo_running:
        return {"status": "already_running"}
    _tomo_running = True
    _tomo_task = asyncio.create_task(_run_tomography(params))
    return {"status": "started"}


@router.post("/tomography/stop")
async def stop_tomography():
    global _tomo_running, _tomo_task
    _tomo_running = False
    if _tomo_task is not None:
        _tomo_task.cancel()
        try:
            await _tomo_task
        except asyncio.CancelledError:
            pass
        _tomo_task = None
    return {"status": "stopped"}


def set_tomo_progress_callback(callback):
    global _tomo_progress_callback
    _tomo_progress_callback = callback


async def _run_tomography(params: TomographyParams):
    global _tomo_running
    try:
        n_cells = params.grid_nx * params.grid_ny * params.grid_nz
        MAX_CELLS_HARD = 8_000_000
        if n_cells > MAX_CELLS_HARD:
            logger.error(f"Grid too large: {n_cells} cells, hard limit {MAX_CELLS_HARD}")
            _tomo_running = False
            return
        arrivals = await db.get_arrivals()
        stations = await db.get_stations()
        events = await db.get_events()
        if len(arrivals) < 3:
            _tomo_running = False
            return
        event_ids = set(a.event_id for a in arrivals if a.event_id is not None)
        filtered_events = [e for e in events if e.id in event_ids]
        G, dt, mem_est = build_ray_matrix(arrivals, stations, filtered_events, params)
        MAX_MEM_MB = 8192
        if mem_est.get("total_MB", 0) > MAX_MEM_MB:
            logger.error(
                f"Memory estimate {mem_est.get('total_MB')} MB exceeds hard limit {MAX_MEM_MB} MB"
            )
            _tomo_running = False
            return
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
        for i, c in enumerate(convergence):
            if _tomo_progress_callback:
                velocity_3d = interpolate_velocity(model, (params.grid_nx, params.grid_ny, params.grid_nz))
                iso_verts, iso_faces = extract_isosurface(velocity_3d)
                iso_data = IsosurfaceData(vertices=iso_verts, faces=iso_faces, iso_level=4500.0) if iso_verts else None
                progress = TomographyProgress(
                    iteration=(i + 1) * max(1, params.max_iter // 25),
                    convergence=c,
                    rms_residual=rms,
                    isosurface=iso_data,
                )
                try:
                    await _tomo_progress_callback(progress)
                except Exception:
                    pass
            await asyncio.sleep(0.05)
        velocity_3d = interpolate_velocity(model, (params.grid_nx, params.grid_ny, params.grid_nz))
        now = datetime.utcnow()
        result = TomographyResult(
            start_time=filtered_events[0].origin_time if filtered_events else now,
            end_time=now,
            grid_nx=params.grid_nx,
            grid_ny=params.grid_ny,
            grid_nz=params.grid_nz,
            origin_lat=params.origin_lat,
            origin_lon=params.origin_lon,
            origin_depth=params.origin_depth,
            spacing_lat=params.spacing_lat,
            spacing_lon=params.spacing_lon,
            spacing_depth=params.spacing_depth,
            velocity_model=velocity_3d.flatten().tolist(),
            rms_residual=rms,
            num_iterations=iterations,
            convergence_history=convergence,
        )
        tomo_id = await db.insert_tomography_result(result)
        result.id = tomo_id
        for eid in event_ids:
            await db.insert_tomography_event(tomo_id, eid)
    except asyncio.CancelledError:
        pass
    except MemoryError as e:
        logger.critical(f"OOM in tomography: {e}")
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Tomography error: {e}", exc_info=True)
    finally:
        gc.collect()
        _tomo_running = False
