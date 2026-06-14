from __future__ import annotations
import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import database as db
from simulator import simulator
from tcp_server import tcp_server
from api_routes import router as api_router, set_tomo_progress_callback
from websocket_handler import (
    router as ws_router,
    broadcast_arrival,
    broadcast_tomography_progress,
    broadcast_event,
)
from models import TomographyParams

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_background_tasks: list[asyncio.Task] = []


async def _on_arrival(arrival, station_name=None):
    await broadcast_arrival(arrival, station_name)


async def _on_event(event):
    await broadcast_event(event)


async def _on_tomo_progress(progress):
    await broadcast_tomography_progress(progress)


async def _auto_tomography():
    try:
        from api_routes import _run_tomography
        params = TomographyParams()
        await _run_tomography(params)
    except Exception as e:
        logger.error(f"Auto tomography error: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    logger.info("Database initialized")
    simulator.on_arrival(_on_arrival)
    simulator.on_event(_on_event)
    set_tomo_progress_callback(_on_tomo_progress)
    simulator.set_tomo_callback(_auto_tomography)
    await simulator.start()
    logger.info("Simulator started")
    try:
        await tcp_server.start()
        logger.info("TCP server started")
    except OSError as e:
        logger.warning(f"TCP server failed to start (port may be in use): {e}")
    yield
    await simulator.stop()
    logger.info("Simulator stopped")
    await tcp_server.stop()
    logger.info("TCP server stopped")
    for task in _background_tasks:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="Fracking Microseismic Real-time Inversion System",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)
app.include_router(ws_router)


@app.get("/")
async def root():
    return {"status": "running", "service": "microseismic-inversion"}


@app.get("/health")
async def health():
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
