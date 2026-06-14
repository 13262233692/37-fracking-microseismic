from __future__ import annotations
import asyncio
import json
import logging
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from models import (
    WaveformSegment, PArrival, ArrivalNotification,
    TomographyProgress,
)
from simulator import ring_buffer, simulator

logger = logging.getLogger(__name__)
router = APIRouter()

_waveform_clients: set[WebSocket] = set()
_arrival_clients: set[WebSocket] = set()
_tomography_clients: set[WebSocket] = set()


@router.websocket("/ws/waveform")
async def ws_waveform(websocket: WebSocket):
    await websocket.accept()
    _waveform_clients.add(websocket)
    try:
        while True:
            latest = ring_buffer.get_all_latest(seconds=0.1)
            for key, (data, start_time) in latest.items():
                parts = key.split("_", 1)
                if len(parts) != 2:
                    continue
                station_id, channel = parts
                segment = WaveformSegment(
                    station_id=station_id,
                    channel=channel,
                    start_time=start_time,
                    end_time=start_time + __import__("datetime").timedelta(seconds=len(data) / ring_buffer.fs),
                    sampling_rate=ring_buffer.fs,
                    data=data.tolist(),
                )
                try:
                    await websocket.send_json(segment.model_dump(mode="json"))
                except Exception:
                    _waveform_clients.discard(websocket)
                    return
            await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        pass
    finally:
        _waveform_clients.discard(websocket)


@router.websocket("/ws/arrivals")
async def ws_arrivals(websocket: WebSocket):
    await websocket.accept()
    _arrival_clients.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _arrival_clients.discard(websocket)


@router.websocket("/ws/tomography")
async def ws_tomography(websocket: WebSocket):
    await websocket.accept()
    _tomography_clients.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _tomography_clients.discard(websocket)


async def broadcast_arrival(arrival: PArrival, station_name: Optional[str] = None):
    notification = ArrivalNotification(arrival=arrival, station_name=station_name)
    message = notification.model_dump(mode="json")
    dead_clients = set()
    for client in _arrival_clients:
        try:
            await client.send_json(message)
        except Exception:
            dead_clients.add(client)
    _arrival_clients.difference_update(dead_clients)


async def broadcast_tomography_progress(progress: TomographyProgress):
    message = progress.model_dump(mode="json")
    dead_clients = set()
    for client in _tomography_clients:
        try:
            await client.send_json(message)
        except Exception:
            dead_clients.add(client)
    _tomography_clients.difference_update(dead_clients)


async def broadcast_event(event):
    message = {
        "type": "new_event",
        "event": {
            "id": event.id,
            "origin_time": event.origin_time.isoformat(),
            "latitude": event.latitude,
            "longitude": event.longitude,
            "depth_km": event.depth_km,
            "magnitude": event.magnitude,
            "num_arrivals": event.num_arrivals,
        },
    }
    dead_clients = set()
    for client in _arrival_clients:
        try:
            await client.send_json(message)
        except Exception:
            dead_clients.add(client)
    _arrival_clients.difference_update(dead_clients)
