import { create } from 'zustand';
import type {
  Station,
  MicroseismicEvent,
  PArrival,
  TomographyProgress,
  TomographyResult,
  FilterParams,
  TomographyParams,
} from '@/types';

const API_BASE = 'http://localhost:8000/api';

interface AppState {
  stations: Station[];
  events: MicroseismicEvent[];
  arrivals: PArrival[];
  activeTomography: TomographyProgress | null;
  tomoRunning: boolean;
  filterParams: FilterParams;
  tomoParams: TomographyParams;
  lastTomographyResult: TomographyResult | null;

  fetchStations: () => Promise<void>;
  fetchEvents: () => Promise<void>;
  fetchArrivals: () => Promise<void>;
  updateFilterParams: (params: FilterParams) => Promise<void>;
  startTomography: (params: TomographyParams) => Promise<void>;
  stopTomography: () => Promise<void>;
  fetchLatestTomography: () => Promise<void>;
}

export const useAppStore = create<AppState>((set) => ({
  stations: [],
  events: [],
  arrivals: [],
  activeTomography: null,
  tomoRunning: false,
  filterParams: { freq_low: 20, freq_high: 200, order: 4 },
  tomoParams: {
    damping: 0.05,
    max_iter: 50,
    grid_nx: 20,
    grid_ny: 20,
    grid_nz: 20,
    origin_lat: 29.5,
    origin_lon: 104.5,
    origin_depth: 0,
    spacing_lat: 0.01,
    spacing_lon: 0.01,
    spacing_depth: 0.1,
  },
  lastTomographyResult: null,

  fetchStations: async () => {
    try {
      const res = await fetch(`${API_BASE}/stations`);
      const data = await res.json();
      set({ stations: data });
    } catch {
      console.error('Failed to fetch stations');
    }
  },

  fetchEvents: async () => {
    try {
      const res = await fetch(`${API_BASE}/events`);
      const data = await res.json();
      set({ events: data });
    } catch {
      console.error('Failed to fetch events');
    }
  },

  fetchArrivals: async () => {
    try {
      const res = await fetch(`${API_BASE}/arrivals`);
      const data = await res.json();
      set({ arrivals: data });
    } catch {
      console.error('Failed to fetch arrivals');
    }
  },

  updateFilterParams: async (params: FilterParams) => {
    try {
      await fetch(`${API_BASE}/filter/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      set({ filterParams: params });
    } catch {
      console.error('Failed to update filter params');
    }
  },

  startTomography: async (params: TomographyParams) => {
    try {
      const res = await fetch(`${API_BASE}/tomography/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (data.status === 'started' || data.status === 'already_running') {
        set({ tomoRunning: true, tomoParams: params });
      }
    } catch {
      console.error('Failed to start tomography');
    }
  },

  stopTomography: async () => {
    try {
      await fetch(`${API_BASE}/tomography/stop`, { method: 'POST' });
      set({ tomoRunning: false, activeTomography: null });
    } catch {
      console.error('Failed to stop tomography');
    }
  },

  fetchLatestTomography: async () => {
    try {
      const res = await fetch(`${API_BASE}/tomography/latest`);
      if (res.ok) {
        const result = await res.json();
        set({ lastTomographyResult: result });
      }
    } catch {
      console.error('Failed to fetch latest tomography');
    }
  },
}));
