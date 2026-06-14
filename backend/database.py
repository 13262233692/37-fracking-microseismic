from __future__ import annotations
import aiosqlite
import json
from datetime import datetime
from typing import Optional
from models import Station, MicroseismicEvent, PArrival, TomographyResult, TomographyEvent, FocalMechanism

DB_PATH = "microseismic.db"

CREATE_STATION = """
CREATE TABLE IF NOT EXISTS station (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    elevation REAL NOT NULL,
    status TEXT DEFAULT 'online'
)
"""

CREATE_MICROSEISMIC_EVENT = """
CREATE TABLE IF NOT EXISTS microseismic_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_time TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    depth_km REAL NOT NULL,
    magnitude REAL NOT NULL,
    num_arrivals INTEGER DEFAULT 0
)
"""

CREATE_P_ARRIVAL = """
CREATE TABLE IF NOT EXISTS p_arrival (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    event_id INTEGER,
    pick_time TEXT NOT NULL,
    snr REAL NOT NULL,
    sta_lta_ratio REAL NOT NULL,
    confidence REAL NOT NULL,
    channel TEXT DEFAULT 'Z',
    polarity INTEGER DEFAULT 0,
    FOREIGN KEY (station_id) REFERENCES station(id),
    FOREIGN KEY (event_id) REFERENCES microseismic_event(id)
)
"""

CREATE_FOCAL_MECHANISM = """
CREATE TABLE IF NOT EXISTS focal_mechanism (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL UNIQUE,
    strike REAL NOT NULL,
    dip REAL NOT NULL,
    rake REAL NOT NULL,
    aux_strike REAL,
    aux_dip REAL,
    aux_rake REAL,
    polarity_misfit REAL,
    used_polarities INTEGER,
    beachball_svg TEXT,
    FOREIGN KEY (event_id) REFERENCES microseismic_event(id)
)
"""

CREATE_TOMOGRAPHY_RESULT = """
CREATE TABLE IF NOT EXISTS tomography_result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    grid_nx INTEGER NOT NULL,
    grid_ny INTEGER NOT NULL,
    grid_nz INTEGER NOT NULL,
    origin_lat REAL NOT NULL,
    origin_lon REAL NOT NULL,
    origin_depth REAL NOT NULL,
    spacing_lat REAL NOT NULL,
    spacing_lon REAL NOT NULL,
    spacing_depth REAL NOT NULL,
    velocity_model TEXT NOT NULL,
    rms_residual REAL NOT NULL,
    num_iterations INTEGER NOT NULL,
    convergence_history TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
"""

CREATE_TOMOGRAPHY_EVENT = """
CREATE TABLE IF NOT EXISTS tomography_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tomography_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    FOREIGN KEY (tomography_id) REFERENCES tomography_result(id),
    FOREIGN KEY (event_id) REFERENCES microseismic_event(id)
)
"""

DEMO_STATIONS = [
    ("S01", "Station-01", 29.52, 104.62, 520.0, "online"),
    ("S02", "Station-02", 29.54, 104.68, 480.0, "online"),
    ("S03", "Station-03", 29.58, 104.64, 510.0, "online"),
    ("S04", "Station-04", 29.50, 104.72, 490.0, "online"),
    ("S05", "Station-05", 29.56, 104.58, 530.0, "online"),
    ("S06", "Station-06", 29.60, 104.70, 500.0, "online"),
]


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("PRAGMA synchronous=NORMAL")
        await db.executescript(CREATE_STATION)
        await db.executescript(CREATE_MICROSEISMIC_EVENT)
        await db.executescript(CREATE_P_ARRIVAL)
        await db.executescript(CREATE_FOCAL_MECHANISM)
        await db.executescript(CREATE_TOMOGRAPHY_RESULT)
        await db.executescript(CREATE_TOMOGRAPHY_EVENT)
        try:
            await db.execute("ALTER TABLE p_arrival ADD COLUMN polarity INTEGER DEFAULT 0")
        except aiosqlite.OperationalError:
            pass
        cursor = await db.execute("SELECT COUNT(*) FROM station")
        row = await cursor.fetchone()
        if row[0] == 0:
            await db.executemany(
                "INSERT INTO station (id, name, latitude, longitude, elevation, status) VALUES (?, ?, ?, ?, ?, ?)",
                DEMO_STATIONS,
            )
        await db.commit()


async def get_stations() -> list[Station]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM station")
        rows = await cursor.fetchall()
        return [Station(**dict(row)) for row in rows]


async def get_station(station_id: str) -> Optional[Station]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM station WHERE id = ?", (station_id,))
        row = await cursor.fetchone()
        if row is None:
            return None
        return Station(**dict(row))


async def insert_event(event: MicroseismicEvent) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "INSERT INTO microseismic_event (origin_time, latitude, longitude, depth_km, magnitude, num_arrivals) VALUES (?, ?, ?, ?, ?, ?)",
            (event.origin_time.isoformat(), event.latitude, event.longitude, event.depth_km, event.magnitude, event.num_arrivals),
        )
        await db.commit()
        return cursor.lastrowid


async def get_events(start: Optional[str] = None, end: Optional[str] = None, min_magnitude: Optional[float] = None) -> list[MicroseismicEvent]:
    query = "SELECT * FROM microseismic_event WHERE 1=1"
    params: list = []
    if start:
        query += " AND origin_time >= ?"
        params.append(start)
    if end:
        query += " AND origin_time <= ?"
        params.append(end)
    if min_magnitude is not None:
        query += " AND magnitude >= ?"
        params.append(min_magnitude)
    query += " ORDER BY origin_time DESC"
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()
        result = []
        for row in rows:
            d = dict(row)
            d["origin_time"] = datetime.fromisoformat(d["origin_time"])
            result.append(MicroseismicEvent(**d))
        return result


async def get_event(event_id: int) -> Optional[MicroseismicEvent]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM microseismic_event WHERE id = ?", (event_id,))
        row = await cursor.fetchone()
        if row is None:
            return None
        d = dict(row)
        d["origin_time"] = datetime.fromisoformat(d["origin_time"])
        return MicroseismicEvent(**d)


async def update_event_arrivals(event_id: int, num_arrivals: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE microseismic_event SET num_arrivals = ? WHERE id = ?", (num_arrivals, event_id))
        await db.commit()


async def insert_arrival(arrival: PArrival) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "INSERT INTO p_arrival (station_id, event_id, pick_time, snr, sta_lta_ratio, confidence, channel, polarity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (arrival.station_id, arrival.event_id, arrival.pick_time.isoformat(), arrival.snr, arrival.sta_lta_ratio, arrival.confidence, arrival.channel, getattr(arrival, 'polarity', 0)),
        )
        await db.commit()
        return cursor.lastrowid


async def update_event_focal(event_id: int, focal: FocalMechanism) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO focal_mechanism (event_id, strike, dip, rake, aux_strike, aux_dip, aux_rake, polarity_misfit, used_polarities, beachball_svg)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(event_id) DO UPDATE SET
                 strike=excluded.strike, dip=excluded.dip, rake=excluded.rake,
                 aux_strike=excluded.aux_strike, aux_dip=excluded.aux_dip, aux_rake=excluded.aux_rake,
                 polarity_misfit=excluded.polarity_misfit, used_polarities=excluded.used_polarities, beachball_svg=excluded.beachball_svg""",
            (event_id, focal.strike, focal.dip, focal.rake,
             getattr(focal, 'strike_aux', None), getattr(focal, 'dip_aux', None), getattr(focal, 'rake_aux', None),
             focal.polarity_misfit, focal.used_polarities, focal.beachball_svg),
        )
        await db.commit()


async def get_event_focal(event_id: int) -> Optional[FocalMechanism]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM focal_mechanism WHERE event_id = ?", (event_id,))
        row = await cursor.fetchone()
        if row is None:
            return None
        d = dict(row)
        return FocalMechanism(
            event_id=event_id,
            strike=d["strike"],
            dip=d["dip"],
            rake=d["rake"],
            strike_aux=d.get("aux_strike", 0.0) if d.get("aux_strike") is not None else 0.0,
            dip_aux=d.get("aux_dip", 0.0) if d.get("aux_dip") is not None else 0.0,
            rake_aux=d.get("aux_rake", 0.0) if d.get("aux_rake") is not None else 0.0,
            polarity_misfit=d.get("polarity_misfit", 0.0),
            used_polarities=d.get("used_polarities", 0),
            beachball_svg=d.get("beachball_svg", ""),
        )


async def get_all_focal() -> list[tuple[int, FocalMechanism]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM focal_mechanism ORDER BY id DESC")
        rows = await cursor.fetchall()
        result = []
        for row in rows:
            d = dict(row)
            fm = FocalMechanism(
                event_id=d["event_id"],
                strike=d["strike"],
                dip=d["dip"],
                rake=d["rake"],
                strike_aux=d.get("aux_strike", 0.0) if d.get("aux_strike") is not None else 0.0,
                dip_aux=d.get("aux_dip", 0.0) if d.get("aux_dip") is not None else 0.0,
                rake_aux=d.get("aux_rake", 0.0) if d.get("aux_rake") is not None else 0.0,
                polarity_misfit=d.get("polarity_misfit", 0.0),
                used_polarities=d.get("used_polarities", 0),
                beachball_svg=d.get("beachball_svg", ""),
            )
            result.append((d["event_id"], fm))
        return result


async def get_arrivals(station_id: Optional[str] = None, event_id: Optional[int] = None) -> list[PArrival]:
    query = "SELECT * FROM p_arrival WHERE 1=1"
    params: list = []
    if station_id:
        query += " AND station_id = ?"
        params.append(station_id)
    if event_id is not None:
        query += " AND event_id = ?"
        params.append(event_id)
    query += " ORDER BY pick_time DESC"
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(query, params)
        rows = await cursor.fetchall()
        result = []
        for row in rows:
            d = dict(row)
            d["pick_time"] = datetime.fromisoformat(d["pick_time"])
            result.append(PArrival(**d))
        return result


async def insert_tomography_result(result: TomographyResult) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "INSERT INTO tomography_result (start_time, end_time, grid_nx, grid_ny, grid_nz, origin_lat, origin_lon, origin_depth, spacing_lat, spacing_lon, spacing_depth, velocity_model, rms_residual, num_iterations, convergence_history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                result.start_time.isoformat(),
                result.end_time.isoformat(),
                result.grid_nx,
                result.grid_ny,
                result.grid_nz,
                result.origin_lat,
                result.origin_lon,
                result.origin_depth,
                result.spacing_lat,
                result.spacing_lon,
                result.spacing_depth,
                json.dumps(result.velocity_model),
                result.rms_residual,
                result.num_iterations,
                json.dumps(result.convergence_history),
            ),
        )
        await db.commit()
        return cursor.lastrowid


async def get_tomography_result(tomo_id: int) -> Optional[TomographyResult]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM tomography_result WHERE id = ?", (tomo_id,))
        row = await cursor.fetchone()
        if row is None:
            return None
        d = dict(row)
        d["start_time"] = datetime.fromisoformat(d["start_time"])
        d["end_time"] = datetime.fromisoformat(d["end_time"])
        d["velocity_model"] = json.loads(d["velocity_model"])
        d["convergence_history"] = json.loads(d["convergence_history"])
        if d.get("created_at"):
            d["created_at"] = datetime.fromisoformat(d["created_at"])
        return TomographyResult(**d)


async def get_latest_tomography_result() -> Optional[TomographyResult]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM tomography_result ORDER BY id DESC LIMIT 1")
        row = await cursor.fetchone()
        if row is None:
            return None
        d = dict(row)
        d["start_time"] = datetime.fromisoformat(d["start_time"])
        d["end_time"] = datetime.fromisoformat(d["end_time"])
        d["velocity_model"] = json.loads(d["velocity_model"])
        d["convergence_history"] = json.loads(d["convergence_history"])
        if d.get("created_at"):
            d["created_at"] = datetime.fromisoformat(d["created_at"])
        return TomographyResult(**d)


async def insert_tomography_event(tomography_id: int, event_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO tomography_event (tomography_id, event_id) VALUES (?, ?)",
            (tomography_id, event_id),
        )
        await db.commit()
