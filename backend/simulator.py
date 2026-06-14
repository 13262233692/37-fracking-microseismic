from __future__ import annotations
import asyncio
import numpy as np
from datetime import datetime, timedelta
from typing import Optional
import database as db
from models import Station, MicroseismicEvent, PArrival, FilterParams
from waveform_processor import butterworth_bandpass, pick_p_arrival


class WaveformRingBuffer:
    def __init__(self, duration_seconds: int = 60, sampling_rate: float = 1000.0):
        self.duration = duration_seconds
        self.fs = sampling_rate
        self.max_samples = int(duration_seconds * sampling_rate)
        self._buffers: dict[str, np.ndarray] = {}
        self._start_times: dict[str, datetime] = {}
        self._write_pos: dict[str, int] = {}

    def _key(self, station_id: str, channel: str) -> str:
        return f"{station_id}_{channel}"

    def init_channel(self, station_id: str, channel: str) -> None:
        key = self._key(station_id, channel)
        if key not in self._buffers:
            self._buffers[key] = np.zeros(self.max_samples, dtype=np.float64)
            self._start_times[key] = datetime.utcnow()
            self._write_pos[key] = 0

    def write(self, station_id: str, channel: str, data: np.ndarray, timestamp: datetime) -> None:
        key = self._key(station_id, channel)
        if key not in self._buffers:
            self.init_channel(station_id, channel)
        buf = self._buffers[key]
        pos = self._write_pos[key]
        n = len(data)
        if n >= self.max_samples:
            self._buffers[key] = data[-self.max_samples:].copy()
            self._write_pos[key] = self.max_samples
            self._start_times[key] = timestamp - timedelta(seconds=self.duration)
            return
        end = pos + n
        if end <= self.max_samples:
            buf[pos:end] = data
            self._write_pos[key] = end
        else:
            first_part = self.max_samples - pos
            buf[pos:] = data[:first_part]
            remaining = n - first_part
            buf[:remaining] = data[first_part:]
            self._write_pos[key] = remaining
            self._start_times[key] = timestamp - timedelta(seconds=self.duration)

    def overlay(self, station_id: str, channel: str, data: np.ndarray, start_time: datetime) -> None:
        key = self._key(station_id, channel)
        if key not in self._buffers:
            return
        buf = self._buffers[key]
        pos = self._write_pos[key]
        buf_start = self._start_times[key]
        offset_s = (start_time - buf_start).total_seconds()
        if offset_s < 0:
            data = data[int(-offset_s * self.fs):]
            offset_s = 0
        start_idx = int(offset_s * self.fs)
        n = len(data)
        if start_idx >= self.max_samples:
            return
        end_idx = min(start_idx + n, self.max_samples)
        actual_n = end_idx - start_idx
        buf[start_idx:end_idx] += data[:actual_n]

    def read(self, station_id: str, channel: str, start: Optional[datetime] = None, end: Optional[datetime] = None) -> Optional[tuple[np.ndarray, datetime]]:
        key = self._key(station_id, channel)
        if key not in self._buffers:
            return None
        buf = self._buffers[key]
        pos = self._write_pos[key]
        start_time = self._start_times[key]
        if pos == 0:
            return None
        valid_data = buf[:pos]
        data_start = start_time
        if start is not None:
            offset_s = (start - data_start).total_seconds()
            offset_samples = max(0, int(offset_s * self.fs))
        else:
            offset_samples = 0
        if end is not None:
            end_offset_s = (end - data_start).total_seconds()
            end_samples = min(len(valid_data), int(end_offset_s * self.fs))
        else:
            end_samples = len(valid_data)
        if offset_samples >= end_samples:
            return None
        result = valid_data[offset_samples:end_samples]
        actual_start = data_start + timedelta(seconds=offset_samples / self.fs)
        return result, actual_start

    def get_latest(self, station_id: str, channel: str, seconds: float = 1.0) -> Optional[tuple[np.ndarray, datetime]]:
        key = self._key(station_id, channel)
        if key not in self._buffers:
            return None
        buf = self._buffers[key]
        pos = self._write_pos[key]
        if pos == 0:
            return None
        n_samples = min(int(seconds * self.fs), pos)
        data = buf[pos - n_samples:pos].copy()
        start_time = self._start_times[key] + timedelta(seconds=(pos - n_samples) / self.fs)
        return data, start_time

    def get_all_latest(self, seconds: float = 1.0) -> dict[str, tuple[np.ndarray, datetime]]:
        result = {}
        for key in self._buffers:
            parts = key.split("_", 1)
            if len(parts) != 2:
                continue
            station_id, channel = parts
            data = self.get_latest(station_id, channel, seconds)
            if data is not None:
                result[key] = data
        return result


class Simulator:
    def __init__(self, ring_buffer: WaveformRingBuffer):
        self.ring_buffer = ring_buffer
        self.filter_params = FilterParams()
        self.running = False
        self._task: Optional[asyncio.Task] = None
        self._arrival_callbacks: list = []
        self._event_callbacks: list = []
        self._arrival_count_since_tomo = 0
        self._tomo_trigger_threshold = 5
        self._tomo_callback: Optional[callable] = None
        self._stations: list[Station] = []
        self._vp = 4500.0

    def on_arrival(self, callback):
        self._arrival_callbacks.append(callback)

    def on_event(self, callback):
        self._event_callbacks.append(callback)

    def set_tomo_callback(self, callback):
        self._tomo_callback = callback

    async def start(self) -> None:
        self._stations = await db.get_stations()
        for station in self._stations:
            for ch in ["Z", "N", "E"]:
                self.ring_buffer.init_channel(station.id, ch)
        self.running = True
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        self.running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def _ricker_wavelet(self, n_samples: int, peak_freq: float = 30.0) -> np.ndarray:
        t = np.arange(n_samples) / self.ring_buffer.fs
        t0 = n_samples / (2 * self.ring_buffer.fs)
        tau = t - t0
        a = (np.pi * peak_freq * tau) ** 2
        return (1 - 2 * a) * np.exp(-a)

    async def _run_loop(self) -> None:
        chunk_duration = 0.5
        chunk_samples = int(chunk_duration * self.ring_buffer.fs)
        next_event_time = datetime.utcnow() + timedelta(seconds=np.random.uniform(3, 8))
        try:
            while self.running:
                now = datetime.utcnow()
                for station in self._stations:
                    for ch in ["Z", "N", "E"]:
                        noise = np.random.normal(0, 0.1, chunk_samples)
                        self.ring_buffer.write(station.id, ch, noise, now)
                if now >= next_event_time:
                    await self._generate_event(now)
                    next_event_time = now + timedelta(seconds=np.random.uniform(5, 30))
                await asyncio.sleep(chunk_duration)
        except asyncio.CancelledError:
            pass

    async def _generate_event(self, event_time: datetime) -> None:
        center_lat = 29.55
        center_lon = 104.65
        event_lat = center_lat + np.random.uniform(-0.03, 0.03)
        event_lon = center_lon + np.random.uniform(-0.03, 0.03)
        event_depth = np.random.uniform(1.0, 4.0)
        magnitude = np.random.uniform(-1.0, 1.0)
        amplitude_scale = 10 ** (magnitude * 0.5 + 1.0) * 20.0
        event = MicroseismicEvent(
            origin_time=event_time,
            latitude=event_lat,
            longitude=event_lon,
            depth_km=event_depth,
            magnitude=magnitude,
            num_arrivals=0,
        )
        event_id = await db.insert_event(event)
        event.id = event_id
        for cb in self._event_callbacks:
            try:
                await cb(event)
            except Exception:
                pass
        pre_noise_duration = 12.0
        post_signal_duration = 3.0
        wavelet_duration = 1.0
        total_duration = pre_noise_duration + wavelet_duration + post_signal_duration
        total_samples = int(total_duration * self.ring_buffer.fs)
        wavelet_samples = int(wavelet_duration * self.ring_buffer.fs)
        arrivals_detected = 0
        for station in self._stations:
            dist_km = self._haversine_km(event_lat, event_lon, station.latitude, station.longitude)
            depth_diff = event_depth - (-station.elevation / 1000.0)
            total_dist = np.sqrt(dist_km ** 2 + depth_diff ** 2)
            travel_time = total_dist / (self._vp / 1000.0)
            for ch_idx, ch in enumerate(["Z", "N", "E"]):
                wavelet = self._ricker_wavelet(wavelet_samples, peak_freq=np.random.uniform(20, 60))
                phase_shift = ch_idx * np.pi / 6
                rotated = wavelet * np.cos(phase_shift) * amplitude_scale
                attenuation = 1.0 / max(1.0, dist_km * 0.3)
                signal = rotated * attenuation
                noise = np.random.normal(0, 0.1, total_samples)
                signal_start = int(pre_noise_duration * self.ring_buffer.fs)
                signal_end = signal_start + wavelet_samples
                if signal_end <= total_samples:
                    noise[signal_start:signal_end] += signal
                composite = noise
                self.ring_buffer.overlay(station.id, ch, composite, event_time + timedelta(seconds=travel_time - pre_noise_duration))
                if ch == "Z":
                    filtered = butterworth_bandpass(
                        composite,
                        self.filter_params.freq_low,
                        self.filter_params.freq_high,
                        self.ring_buffer.fs,
                        self.filter_params.order,
                    )
                    picks = pick_p_arrival(
                        filtered,
                        self.ring_buffer.fs,
                        threshold=3.0,
                        sta_len=0.5,
                        lta_len=5.0,
                    )
                    for pick_time_s, snr, sta_lta_ratio, confidence in picks:
                        actual_pick = event_time + timedelta(seconds=travel_time - pre_noise_duration + pick_time_s)
                        arrival = PArrival(
                            station_id=station.id,
                            event_id=event_id,
                            pick_time=actual_pick,
                            snr=snr,
                            sta_lta_ratio=sta_lta_ratio,
                            confidence=confidence,
                            channel=ch,
                        )
                        arrival_id = await db.insert_arrival(arrival)
                        arrival.id = arrival_id
                        arrivals_detected += 1
                        self._arrival_count_since_tomo += 1
                        for cb in self._arrival_callbacks:
                            try:
                                await cb(arrival, station.name)
                            except Exception:
                                pass
        if arrivals_detected > 0:
            await db.update_event_arrivals(event_id, arrivals_detected)
        if self._arrival_count_since_tomo >= self._tomo_trigger_threshold:
            self._arrival_count_since_tomo = 0
            if self._tomo_callback:
                try:
                    await self._tomo_callback()
                except Exception:
                    pass

    @staticmethod
    def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        R = 6371.0
        dlat = np.radians(lat2 - lat1)
        dlon = np.radians(lon2 - lon1)
        a = np.sin(dlat / 2) ** 2 + np.cos(np.radians(lat1)) * np.cos(np.radians(lat2)) * np.sin(dlon / 2) ** 2
        c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
        return R * c


ring_buffer = WaveformRingBuffer(duration_seconds=60, sampling_rate=1000.0)
simulator = Simulator(ring_buffer)
