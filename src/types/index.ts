export interface Station {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  elevation: number;
  status: string;
}

export interface WaveformSegment {
  station_id: string;
  channel: string;
  start_time: string;
  end_time: string;
  sampling_rate: number;
  data: number[];
}

export interface PArrival {
  id?: number;
  station_id: string;
  event_id?: number | null;
  pick_time: string;
  snr: number;
  sta_lta_ratio: number;
  confidence: number;
  channel: string;
}

export interface MicroseismicEvent {
  id?: number;
  origin_time: string;
  latitude: number;
  longitude: number;
  depth_km: number;
  magnitude: number;
  num_arrivals: number;
}

export interface TomographyResult {
  id?: number;
  start_time: string;
  end_time: string;
  grid_nx: number;
  grid_ny: number;
  grid_nz: number;
  origin_lat: number;
  origin_lon: number;
  origin_depth: number;
  spacing_lat: number;
  spacing_lon: number;
  spacing_depth: number;
  velocity_model: number[];
  rms_residual: number;
  num_iterations: number;
  convergence_history: number[];
  created_at?: string | null;
}

export interface FilterParams {
  freq_low: number;
  freq_high: number;
  order: number;
}

export interface TomographyParams {
  damping: number;
  max_iter: number;
  grid_nx: number;
  grid_ny: number;
  grid_nz: number;
  origin_lat: number;
  origin_lon: number;
  origin_depth: number;
  spacing_lat: number;
  spacing_lon: number;
  spacing_depth: number;
}

export interface IsosurfaceData {
  vertices: number[][];
  faces: number[][];
  iso_level: number;
}

export interface TomographyProgress {
  iteration: number;
  convergence: number;
  rms_residual: number;
  isosurface: IsosurfaceData | null;
}

export interface ArrivalNotification {
  arrival: PArrival;
  station_name?: string | null;
}
