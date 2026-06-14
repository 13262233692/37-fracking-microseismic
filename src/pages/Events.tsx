import { useState, useEffect, useCallback, useRef } from 'react';
import Plot from 'react-plotly.js';
import { Search, RotateCcw, Play, MapPin } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import type { MicroseismicEvent, PArrival, WaveformSegment } from '@/types';

const API_BASE = 'http://localhost:8000/api';
const PAGE_SIZE = 20;

type SortField = 'id' | 'origin_time' | 'latitude' | 'longitude' | 'depth_km' | 'magnitude' | 'num_arrivals';
type SortDir = 'asc' | 'desc';

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function depthToColor(depth: number, minD: number, maxD: number): string {
  const t = maxD === minD ? 0.5 : (depth - minD) / (maxD - minD);
  const r = Math.round(t * 255);
  const b = Math.round((1 - t) * 255);
  return `rgb(${r},50,${b})`;
}

export default function Events() {
  const { stations, events, fetchStations, fetchEvents } = useAppStore();

  const [selectedEvent, setSelectedEvent] = useState<MicroseismicEvent | null>(null);
  const [arrivals, setArrivals] = useState<PArrival[]>([]);
  const [waveform, setWaveform] = useState<WaveformSegment | null>(null);
  const [sortField, setSortField] = useState<SortField>('origin_time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);
  const [filterStart, setFilterStart] = useState('');
  const [filterEnd, setFilterEnd] = useState('');
  const [filterMinMag, setFilterMinMag] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [playOffset, setPlayOffset] = useState(0);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchStations();
    fetchEvents();
  }, [fetchStations, fetchEvents]);

  const handleSearch = useCallback(() => {
    const params = new URLSearchParams();
    if (filterStart) params.set('start_time', filterStart);
    if (filterEnd) params.set('end_time', filterEnd);
    if (filterMinMag) params.set('min_magnitude', filterMinMag);
    fetch(`${API_BASE}/events?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => useAppStore.setState({ events: data }))
      .catch(() => {});
  }, [filterStart, filterEnd, filterMinMag]);

  const handleReset = useCallback(() => {
    setFilterStart('');
    setFilterEnd('');
    setFilterMinMag('');
    fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    if (!selectedEvent) {
      setArrivals([]);
      setWaveform(null);
      return;
    }
    fetch(`${API_BASE}/arrivals?event_id=${selectedEvent.id}`)
      .then((r) => r.json())
      .then((data: PArrival[]) => setArrivals(Array.isArray(data) ? data : []))
      .catch(() => setArrivals([]));

    if (stations.length === 0) return;
    const station = stations[0];
    const origin = new Date(selectedEvent.origin_time);
    const start = new Date(origin.getTime() - 5000).toISOString();
    const end = new Date(origin.getTime() + 15000).toISOString();
    fetch(`${API_BASE}/waveform?station_id=${station.id}&start_time=${start}&end_time=${end}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) setWaveform(data[0]);
        else if (data && data.data) setWaveform(data);
        else setWaveform(null);
      })
      .catch(() => setWaveform(null));
  }, [selectedEvent, stations]);

  const sortedEvents = [...events].sort((a, b) => {
    const av = a[sortField] ?? 0;
    const bv = b[sortField] ?? 0;
    if (typeof av === 'string') return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
  });

  const totalPages = Math.ceil(sortedEvents.length / PAGE_SIZE);
  const pagedEvents = sortedEvents.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('asc'); }
  };

  const handleMapClick = (event: { points?: { pointIndex?: number }[] }) => {
    if (event.points && event.points.length > 0) {
      const idx = event.points[0].pointIndex;
      if (idx !== undefined && idx < events.length) {
        setSelectedEvent(events[idx]);
        setIsPlaying(false);
        setPlayOffset(0);
      }
    }
  };

  const handlePlay = () => {
    if (!waveform) return;
    if (isPlaying) {
      setIsPlaying(false);
      if (playRef.current) clearInterval(playRef.current);
      return;
    }
    setIsPlaying(true);
    setPlayOffset(0);
    playRef.current = setInterval(() => {
      setPlayOffset((prev) => {
        if (prev >= (waveform?.data.length ?? 0) - 200) {
          setIsPlaying(false);
          if (playRef.current) clearInterval(playRef.current);
          return prev;
        }
        return prev + 10;
      });
    }, 50);
  };

  useEffect(() => {
    return () => { if (playRef.current) clearInterval(playRef.current); };
  }, []);

  const depths = events.map((e) => e.depth_km);
  const minDepth = Math.min(...depths, 0);
  const maxDepth = Math.max(...depths, 1);

  const columns: { field: SortField; label: string }[] = [
    { field: 'id', label: 'ID' },
    { field: 'origin_time', label: '发震时刻' },
    { field: 'latitude', label: '纬度' },
    { field: 'longitude', label: '经度' },
    { field: 'depth_km', label: '深度(km)' },
    { field: 'magnitude', label: '震级' },
    { field: 'num_arrivals', label: '到时数' },
  ];

  const mapLats = events.map((e) => e.latitude);
  const mapLons = events.map((e) => e.longitude);
  const centerLat = mapLats.length > 0 ? mapLats.reduce((a, b) => a + b, 0) / mapLats.length : 29.55;
  const centerLon = mapLons.length > 0 ? mapLons.reduce((a, b) => a + b, 0) / mapLons.length : 104.65;

  const waveformX = waveform
    ? waveform.data.map((_, i) => i / waveform.sampling_rate)
    : [];
  const waveformY = waveform ? waveform.data : [];
  const windowSize = 200;
  const wfX = waveformX.slice(playOffset, playOffset + windowSize);
  const wfY = waveformY.slice(playOffset, playOffset + windowSize);

  const arrivalLines = waveform
    ? arrivals
        .map((a) => {
          const arrivalSec = (new Date(a.pick_time).getTime() - new Date(waveform!.start_time).getTime()) / 1000;
          if (wfX.length === 0 || arrivalSec < wfX[0] || arrivalSec > wfX[wfX.length - 1]) return null;
          return {
            type: 'line' as const,
            x0: arrivalSec, x1: arrivalSec,
            y0: 0, y1: 1, yref: 'paper' as const,
            line: { color: '#FF3D00', width: 2, dash: 'dash' as const },
          };
        })
        .filter(Boolean)
    : [];

  return (
    <div className="flex h-full gap-4">
      <div className="flex w-[60%] flex-col gap-4">
        <div className="flex min-h-[340px] flex-col rounded-lg border border-steel-500 bg-space-800">
          <div className="flex items-center gap-2 border-b border-steel-500 px-4 py-2">
            <MapPin size={16} className="text-accent-blue" />
            <span className="font-mono text-sm font-medium text-text-primary">事件地图</span>
          </div>
          <div className="flex-1 p-2">
            <Plot
              data={[
                {
                  type: 'scattergeo',
                  lat: events.map((e) => e.latitude),
                  lon: events.map((e) => e.longitude),
                  text: events.map((e) =>
                    `ID: ${e.id}<br>震级: ${e.magnitude}<br>深度: ${e.depth_km}km<br>时间: ${formatTime(e.origin_time)}`
                  ),
                  marker: {
                    size: events.map((e) => Math.max(6, e.magnitude * 8)),
                    color: events.map((e) => depthToColor(e.depth_km, minDepth, maxDepth)),
                    opacity: 0.85,
                    line: { color: '#E8ECF4', width: 0.5 },
                  },
                  hoverinfo: 'text',
                  name: '微地震事件',
                },
                {
                  type: 'scattergeo',
                  lat: stations.map((s) => s.latitude),
                  lon: stations.map((s) => s.longitude),
                  text: stations.map((s) => `台站: ${s.name}`),
                  marker: {
                    symbol: 'triangle-up',
                    size: 10,
                    color: '#00E5FF',
                    line: { color: '#E8ECF4', width: 1 },
                  },
                  hoverinfo: 'text',
                  name: '台站',
                },
              ]}
              layout={{
                geo: {
                  bgcolor: '#0A0E17',
                  landcolor: '#1A1F2E',
                  lakecolor: '#0A0E17',
                  showland: true,
                  showlakes: true,
                  center: { lat: centerLat, lon: centerLon },
                  projection: { type: 'mercator', scale: 50 },
                  showframe: false,
                  coastlinecolor: '#2A3040',
                  countrycolor: '#2A3040',
                },
                margin: { t: 10, b: 10, l: 10, r: 10 },
                paper_bgcolor: '#0A0E17',
                font: { color: '#7A849B', family: 'IBM Plex Sans' },
                legend: {
                  bgcolor: 'rgba(10,14,23,0.8)',
                  font: { color: '#E8ECF4', size: 11 },
                  x: 0.02, y: 0.98,
                },
                showlegend: true,
              }}
              config={{ displayModeBar: false, responsive: true }}
              style={{ width: '100%', height: '100%' }}
              onClick={handleMapClick}
            />
          </div>
        </div>

        <div className="flex flex-col rounded-lg border border-steel-500 bg-space-800">
          <div className="flex items-center gap-3 border-b border-steel-500 px-4 py-2">
            <Search size={14} className="text-text-secondary" />
            <input
              type="datetime-local"
              value={filterStart}
              onChange={(e) => setFilterStart(e.target.value)}
              className="rounded border border-steel-500 bg-space px-2 py-1 text-xs text-text-primary outline-none focus:border-accent-blue"
            />
            <span className="text-xs text-text-secondary">至</span>
            <input
              type="datetime-local"
              value={filterEnd}
              onChange={(e) => setFilterEnd(e.target.value)}
              className="rounded border border-steel-500 bg-space px-2 py-1 text-xs text-text-primary outline-none focus:border-accent-blue"
            />
            <span className="text-xs text-text-secondary">最小震级</span>
            <input
              type="number"
              step="0.1"
              value={filterMinMag}
              onChange={(e) => setFilterMinMag(e.target.value)}
              className="w-20 rounded border border-steel-500 bg-space px-2 py-1 text-xs text-text-primary outline-none focus:border-accent-blue"
            />
            <button
              onClick={handleSearch}
              className="flex items-center gap-1 rounded bg-accent-blue px-3 py-1 text-xs font-medium text-space transition-colors hover:opacity-80"
            >
              <Search size={12} /> 搜索
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-1 rounded border border-steel-500 px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-steel-600 hover:text-text-primary"
            >
              <RotateCcw size={12} /> 重置
            </button>
          </div>

          <div className="overflow-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-steel-500 bg-steel">
                  {columns.map(({ field, label }) => (
                    <th
                      key={field}
                      onClick={() => handleSort(field)}
                      className="cursor-pointer whitespace-nowrap px-3 py-2 font-mono font-medium text-text-secondary transition-colors hover:text-accent-blue"
                    >
                      {label}
                      {sortField === field && (
                        <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedEvents.map((evt) => (
                  <tr
                    key={evt.id}
                    onClick={() => {
                      setSelectedEvent(evt);
                      setIsPlaying(false);
                      setPlayOffset(0);
                    }}
                    className={`cursor-pointer border-b border-steel-500 transition-colors ${
                      selectedEvent?.id === evt.id
                        ? 'bg-accent-blue/15 text-accent-blue'
                        : 'text-text-primary hover:bg-steel-600'
                    }`}
                  >
                    <td className="px-3 py-1.5 font-mono">{evt.id}</td>
                    <td className="px-3 py-1.5">{formatTime(evt.origin_time)}</td>
                    <td className="px-3 py-1.5 font-mono">{evt.latitude.toFixed(4)}</td>
                    <td className="px-3 py-1.5 font-mono">{evt.longitude.toFixed(4)}</td>
                    <td className="px-3 py-1.5 font-mono">{evt.depth_km.toFixed(2)}</td>
                    <td className="px-3 py-1.5 font-mono">{evt.magnitude.toFixed(1)}</td>
                    <td className="px-3 py-1.5 font-mono">{evt.num_arrivals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-steel-500 px-4 py-2">
            <span className="text-xs text-text-secondary">
              共 {sortedEvents.length} 条，第 {page + 1}/{totalPages || 1} 页
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="rounded border border-steel-500 px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-steel-600 disabled:opacity-30"
              >
                上一页
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="rounded border border-steel-500 px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-steel-600 disabled:opacity-30"
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex w-[40%] flex-col gap-4">
        {!selectedEvent ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-steel-500 bg-space-800">
            <div className="text-center">
              <MapPin size={32} className="mx-auto mb-3 text-text-secondary opacity-40" />
              <p className="text-sm text-text-secondary">选择一个事件查看详情</p>
            </div>
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-steel-500 bg-space-800">
              <div className="border-b border-steel-500 px-4 py-2">
                <span className="font-mono text-sm font-medium text-accent-blue">事件参数</span>
              </div>
              <div className="grid grid-cols-2 gap-3 p-4">
                {[
                  ['发震时刻', formatTime(selectedEvent.origin_time)],
                  ['纬度', selectedEvent.latitude.toFixed(4)],
                  ['经度', selectedEvent.longitude.toFixed(4)],
                  ['深度', `${selectedEvent.depth_km.toFixed(2)} km`],
                  ['震级', selectedEvent.magnitude.toFixed(1)],
                  ['到时数', String(selectedEvent.num_arrivals)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span className="text-xs text-text-secondary">{label}</span>
                    <p className="font-mono text-sm text-text-primary">{value}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-auto rounded-lg border border-steel-500 bg-space-800">
              <div className="border-b border-steel-500 px-4 py-2">
                <span className="font-mono text-sm font-medium text-accent-blue">到时信息</span>
              </div>
              {arrivals.length === 0 ? (
                <p className="p-4 text-xs text-text-secondary">无到时数据</p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-steel-500 bg-steel">
                      <th className="px-3 py-1.5 font-mono font-medium text-text-secondary">台站</th>
                      <th className="px-3 py-1.5 font-mono font-medium text-text-secondary">到时</th>
                      <th className="px-3 py-1.5 font-mono font-medium text-text-secondary">SNR</th>
                      <th className="px-3 py-1.5 font-mono font-medium text-text-secondary">置信度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {arrivals.map((a, i) => (
                      <tr key={a.id ?? i} className="border-b border-steel-500 text-text-primary">
                        <td className="px-3 py-1.5 font-mono">{a.station_id}</td>
                        <td className="px-3 py-1.5">{formatTime(a.pick_time)}</td>
                        <td className="px-3 py-1.5 font-mono">{a.snr.toFixed(1)}</td>
                        <td className="px-3 py-1.5 font-mono">{(a.confidence * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="rounded-lg border border-steel-500 bg-space-800">
              <div className="flex items-center justify-between border-b border-steel-500 px-4 py-2">
                <span className="font-mono text-sm font-medium text-accent-blue">波形回放</span>
                <button
                  onClick={handlePlay}
                  disabled={!waveform}
                  className={`flex items-center gap-1 rounded px-3 py-1 text-xs font-medium transition-colors ${
                    isPlaying
                      ? 'bg-accent-red text-white hover:opacity-80'
                      : 'bg-accent-blue text-space hover:opacity-80 disabled:opacity-30'
                  }`}
                >
                  <Play size={12} /> {isPlaying ? '停止' : '播放'}
                </button>
              </div>
              <div className="p-2">
                {!waveform ? (
                  <p className="py-8 text-center text-xs text-text-secondary">无波形数据</p>
                ) : (
                  <Plot
                    data={[
                      {
                        x: wfX,
                        y: wfY,
                        type: 'scattergl',
                        mode: 'lines',
                        line: { color: '#00E5FF', width: 1 },
                        name: stations[0]?.name ?? '波形',
                      },
                    ]}
                    layout={{
                      paper_bgcolor: '#0A0E17',
                      plot_bgcolor: '#0A0E17',
                      margin: { t: 10, b: 40, l: 50, r: 10 },
                      font: { color: '#7A849B', family: 'JetBrains Mono', size: 10 },
                      xaxis: {
                        title: { text: '时间 (s)' },
                        gridcolor: '#1A1F2E',
                        zerolinecolor: '#2A3040',
                        color: '#7A849B',
                      },
                      yaxis: {
                        title: { text: '振幅' },
                        gridcolor: '#1A1F2E',
                        zerolinecolor: '#2A3040',
                        color: '#7A849B',
                      },
                      shapes: arrivalLines as Plotly.Shape[],
                      height: 200,
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%' }}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
