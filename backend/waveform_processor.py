from __future__ import annotations
import numpy as np
from scipy.signal import butter, sosfiltfilt
from typing import Optional


def butterworth_bandpass(
    data: np.ndarray,
    freq_low: float = 20.0,
    freq_high: float = 200.0,
    fs: float = 1000.0,
    order: int = 4,
) -> np.ndarray:
    nyquist = fs / 2.0
    low = freq_low / nyquist
    high = freq_high / nyquist
    low = max(low, 0.001)
    high = min(high, 0.999)
    if low >= high:
        return data.copy()
    sos = butter(order, [low, high], btype="band", output="sos")
    return sosfiltfilt(sos, data)


def sta_lta(
    data: np.ndarray,
    sta_len: float = 0.5,
    lta_len: float = 10.0,
    fs: float = 1000.0,
) -> np.ndarray:
    n_sta = max(int(sta_len * fs), 1)
    n_lta = max(int(lta_len * fs), n_sta + 1)
    n = len(data)
    if n < n_lta:
        return np.zeros(n)
    abs_data = np.abs(data)
    cumsum = np.cumsum(abs_data)
    cumsum = np.insert(cumsum, 0, 0)
    indices = np.arange(n_lta, n)
    sta = (cumsum[indices] - cumsum[indices - n_sta]) / n_sta
    lta = (cumsum[indices] - cumsum[indices - n_lta]) / n_lta
    lta = np.where(lta < 1e-10, 1e-10, lta)
    ratio = np.zeros(n)
    ratio[n_lta:] = sta / lta
    return ratio


def pick_p_arrival(
    data: np.ndarray,
    fs: float = 1000.0,
    threshold: float = 3.5,
    sta_len: float = 0.5,
    lta_len: float = 10.0,
) -> list[tuple[float, float, float, float]]:
    ratio = sta_lta(data, sta_len, lta_len, fs)
    picks: list[tuple[float, float, float, float]] = []
    above = ratio > threshold
    if not np.any(above):
        return picks
    diff = np.diff(above.astype(int))
    trigger_on = np.where(diff == 1)[0]
    for idx in trigger_on:
        peak_idx = idx
        search_end = min(idx + int(2.0 * fs), len(ratio))
        if search_end > idx + 1:
            peak_idx = idx + np.argmax(ratio[idx:search_end])
        peak_ratio = float(ratio[peak_idx])
        pick_time_s = peak_idx / fs
        window_start = max(0, peak_idx - int(0.5 * fs))
        window_end = min(len(data), peak_idx + int(0.5 * fs))
        signal_rms = np.sqrt(np.mean(data[peak_idx:window_end] ** 2)) if peak_idx < window_end else 1e-10
        noise_rms = np.sqrt(np.mean(data[window_start:idx] ** 2)) if idx > window_start else 1e-10
        snr = signal_rms / max(noise_rms, 1e-10)
        confidence = min(1.0, (peak_ratio / threshold) * 0.5 + (snr / 10.0) * 0.5)
        picks.append((pick_time_s, float(snr), peak_ratio, float(confidence)))
    return picks
