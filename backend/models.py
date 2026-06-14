from __future__ import annotations
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field


class Station(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    latitude: float
    longitude: float
    elevation: float
    status: str = "online"


class WaveformSegment(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    station_id: str
    channel: str
    start_time: datetime
    end_time: datetime
    sampling_rate: float
    data: list[float]


class PArrival(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: Optional[int] = None
    station_id: str
    event_id: Optional[int] = None
    pick_time: datetime
    snr: float
    sta_lta_ratio: float
    confidence: float
    channel: str = "Z"
    polarity: int = 0


class FocalMechanism(BaseModel):
    event_id: int
    strike: float
    dip: float
    rake: float
    strike_aux: float
    dip_aux: float
    rake_aux: float
    polarity_misfit: float
    used_polarities: int
    beachball_svg: str


class MicroseismicEvent(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: Optional[int] = None
    origin_time: datetime
    latitude: float
    longitude: float
    depth_km: float
    magnitude: float
    num_arrivals: int = 0
    focal: Optional[FocalMechanism] = None


class TomographyResult(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: Optional[int] = None
    start_time: datetime
    end_time: datetime
    grid_nx: int
    grid_ny: int
    grid_nz: int
    origin_lat: float
    origin_lon: float
    origin_depth: float
    spacing_lat: float
    spacing_lon: float
    spacing_depth: float
    velocity_model: list[float]
    rms_residual: float
    num_iterations: int
    convergence_history: list[float]
    created_at: Optional[datetime] = None


class TomographyEvent(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: Optional[int] = None
    tomography_id: int
    event_id: int


class FilterParams(BaseModel):
    freq_low: float = Field(default=20.0, ge=1.0, le=400.0)
    freq_high: float = Field(default=200.0, ge=1.0, le=450.0)
    order: int = Field(default=4, ge=1, le=8)


class TomographyParams(BaseModel):
    damping: float = Field(default=0.05, ge=0.001, le=10.0)
    smoothness_weight: float = Field(default=0.1, ge=0.0, le=100.0)
    max_iter: int = Field(default=50, ge=5, le=500)
    grid_nx: int = Field(default=20, ge=5, le=500)
    grid_ny: int = Field(default=20, ge=5, le=500)
    grid_nz: int = Field(default=20, ge=5, le=500)
    origin_lat: float = Field(default=29.5)
    origin_lon: float = Field(default=104.5)
    origin_depth: float = Field(default=0.0)
    spacing_lat: float = Field(default=0.01)
    spacing_lon: float = Field(default=0.01)
    spacing_depth: float = Field(default=0.1)


class IsosurfaceData(BaseModel):
    vertices: list[list[float]]
    faces: list[list[int]]
    iso_level: float


class TomographyProgress(BaseModel):
    iteration: int
    convergence: float
    rms_residual: float
    isosurface: Optional[IsosurfaceData] = None


class ArrivalNotification(BaseModel):
    arrival: PArrival
    station_name: Optional[str] = None
