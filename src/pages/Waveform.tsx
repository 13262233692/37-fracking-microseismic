import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Plot from 'react-plotly.js';
import { Activity, Filter, SlidersHorizontal, ListChecks, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import type { WaveformSegment, PArrival, FilterParams } from '@/types';

const API_BASE = 'http://localhost:8000/api';

interface ChannelTrace {
  channel: string;
  times: number[];
  amplitudes: number[];
}

interface StaltaTrace {
  channel: string;
  times: number[];
  ratios: number[];
}

function computeSTA_LTA(amplitudes: number[], staLen: number, ltaLen: number): number[] {
  if (amplitudes.length < ltaLen) return [];
  const result: number[] = [];
  for (let i = 0; i < amplitudes.length; i++) {
    if (i < ltaLen - 1) {
      result.push(0);
      continue;
    }
    const staStart = Math.max(0, i - staLen + 1);
    let staSum = 0;
    for (let j = staStart; j <= i; j++) staSum += Math.abs(amplitudes[j]);
    const sta = staSum / staLen;

    const ltaStart = Math.max(0, i - ltaLen + 1);
    let ltaSum = 0;
    for (let j = ltaStart; j <= i; j++) ltaSum += Math.abs(amplitudes[j]);
    const lta = ltaSum / ltaLen;

    result.push(lta > 0 ? sta / lta : 0);
  }
  return result;
}

function FilterControlPanel() {
  const filterParams = useAppStore((s) => s.filterParams);
  const updateFilterParams = useAppStore((s) => s.updateFilterParams);
  const [localParams, setLocalParams] = useState<FilterParams>(filterParams);
  const [applying, setApplying] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setLocalParams(filterParams);
  }, [filterParams]);

  const debouncedSet = useCallback((params: FilterParams) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLocalParams(params);
    }, 300);
  }, []);

  const handleChange = (field: keyof FilterParams, value: number) => {
    const next = { ...localParams, [field]: value };
    debouncedSet(next);
    setLocalParams(next);
  };

  const handleApply = async () => {
    setApplying(true);
    await updateFilterParams(localParams);
    setApplying(false);
  };

  return (
    <div className="rounded-xl border border-steel-500 bg-space-700 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Filter size={16} className="text-accent-blue" />
        <h3 className="font-mono text-sm font-semibold text-text-primary">滤波器控制</h3>
      </div>
      <div className="space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs text-text-secondary">低频截止</label>
            <span className="font-mono text-xs text-accent-blue">{localParams.freq_low} Hz</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={400}
              value={localParams.freq_low}
              onChange={(e) => handleChange('freq_low', Number(e.target.value))}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-steel-500 accent-accent-blue"
            />
            <input
              type="number"
              min={1}
              max={400}
              value={localParams.freq_low}
              onChange={(e) => handleChange('freq_low', Number(e.target.value))}
              className="w-16 rounded border border-steel-500 bg-space-800 px-2 py-1 text-center font-mono text-xs text-text-primary focus:border-accent-blue focus:outline-none"
            />
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs text-text-secondary">高频截止</label>
            <span className="font-mono text-xs text-accent-blue">{localParams.freq_high} Hz</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={450}
              value={localParams.freq_high}
              onChange={(e) => handleChange('freq_high', Number(e.target.value))}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-steel-500 accent-accent-blue"
            />
            <input
              type="number"
              min={1}
              max={450}
              value={localParams.freq_high}
              onChange={(e) => handleChange('freq_high', Number(e.target.value))}
              className="w-16 rounded border border-steel-500 bg-space-800 px-2 py-1 text-center font-mono text-xs text-text-primary focus:border-accent-blue focus:outline-none"
            />
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs text-text-secondary">滤波阶数</label>
            <span className="font-mono text-xs text-accent-blue">{localParams.order}</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={8}
              value={localParams.order}
              onChange={(e) => handleChange('order', Number(e.target.value))}
              className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-steel-500 accent-accent-blue"
            />
            <input
              type="number"
              min={1}
              max={8}
              value={localParams.order}
              onChange={(e) => handleChange('order', Number(e.target.value))}
              className="w-16 rounded border border-steel-500 bg-space-800 px-2 py-1 text-center font-mono text-xs text-text-primary focus:border-accent-blue focus:outline-none"
            />
          </div>
        </div>
      </div>
      <button
        onClick={handleApply}
        disabled={applying}
        className="mt-4 w-full rounded-lg bg-accent-blue/20 py-2 font-mono text-sm font-medium text-accent-blue transition-all duration-300 hover:bg-accent-blue/30 hover:shadow-[0_0_20px_rgba(0,229,255,0.3)] disabled:opacity-50"
      >
        {applying ? '应用中...' : '应用滤波'}
      </button>
    </div>
  );
}

function StaltaPanel() {
  const [staWindow, setStaWindow] = useState(0.5);
  const [ltaWindow, setLtaWindow] = useState(5.0);
  const [triggerThreshold, setTriggerThreshold] = useState(3.5);

  return (
    <div className="rounded-xl border border-steel-500 bg-space-700 p-4">
      <div className="mb-3 flex items-center gap-2">
        <SlidersHorizontal size={16} className="text-accent-blue" />
        <h3 className="font-mono text-sm font-semibold text-text-primary">STA/LTA 参数</h3>
      </div>
      <div className="space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs text-text-secondary">STA 窗长</label>
            <span className="font-mono text-xs text-accent-blue">{staWindow} s</span>
          </div>
          <input
            type="number"
            min={0.1}
            max={10}
            step={0.1}
            value={staWindow}
            onChange={(e) => setStaWindow(Number(e.target.value))}
            className="w-full rounded border border-steel-500 bg-space-800 px-3 py-1.5 font-mono text-xs text-text-primary focus:border-accent-blue focus:outline-none"
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs text-text-secondary">LTA 窗长</label>
            <span className="font-mono text-xs text-accent-blue">{ltaWindow} s</span>
          </div>
          <input
            type="number"
            min={0.5}
            max={60}
            step={0.5}
            value={ltaWindow}
            onChange={(e) => setLtaWindow(Number(e.target.value))}
            className="w-full rounded border border-steel-500 bg-space-800 px-3 py-1.5 font-mono text-xs text-text-primary focus:border-accent-blue focus:outline-none"
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs text-text-secondary">触发阈值</label>
            <span className="font-mono text-xs text-accent-blue">{triggerThreshold}</span>
          </div>
          <input
            type="number"
            min={1}
            max={10}
            step={0.5}
            value={triggerThreshold}
            onChange={(e) => setTriggerThreshold(Number(e.target.value))}
            className="w-full rounded border border-steel-500 bg-space-800 px-3 py-1.5 font-mono text-xs text-text-primary focus:border-accent-blue focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
}

function ArrivalListPanel() {
  const arrivals = useAppStore((s) => s.arrivals);
  const fetchArrivals = useAppStore((s) => s.fetchArrivals);
  const stations = useAppStore((s) => s.stations);

  useEffect(() => {
    fetchArrivals();
    const interval = setInterval(fetchArrivals, 5000);
    return () => clearInterval(interval);
  }, [fetchArrivals]);

  const stationMap = useMemo(() => {
    const m = new Map<string, string>();
    stations.forEach((s) => m.set(s.id, s.name));
    return m;
  }, [stations]);

  const sortedArrivals = useMemo(
    () => [...arrivals].sort((a, b) => b.pick_time.localeCompare(a.pick_time)).slice(0, 50),
    [arrivals],
  );

  return (
    <div className="rounded-xl border border-steel-500 bg-space-700 p-4">
      <div className="mb-3 flex items-center gap-2">
        <ListChecks size={16} className="text-accent-blue" />
        <h3 className="font-mono text-sm font-semibold text-text-primary">到时列表</h3>
        <span className="ml-auto font-mono text-xs text-text-secondary">{arrivals.length} 条</span>
      </div>
      <div className="overflow-auto max-h-[280px] custom-scrollbar">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-steel-500">
              <th className="pb-2 text-left font-mono font-medium text-text-secondary">台站</th>
              <th className="pb-2 text-left font-mono font-medium text-text-secondary">到时</th>
              <th className="pb-2 text-right font-mono font-medium text-text-secondary">SNR</th>
              <th className="pb-2 text-right font-mono font-medium text-text-secondary">STA/LTA</th>
              <th className="pb-2 text-right font-mono font-medium text-text-secondary">置信度</th>
            </tr>
          </thead>
          <tbody>
            {sortedArrivals.map((a, i) => (
              <tr
                key={a.id ?? i}
                className={`border-b border-steel-500/50 ${
                  i % 2 === 0 ? 'bg-space-800/40' : 'bg-transparent'
                }`}
              >
                <td className="py-1.5 font-mono text-text-primary">
                  {stationMap.get(a.station_id) || a.station_id}
                </td>
                <td className="py-1.5 font-mono text-text-primary">
                  {a.pick_time.slice(11, 23)}
                </td>
                <td className="py-1.5 text-right font-mono text-text-primary">
                  {a.snr.toFixed(1)}
                </td>
                <td className="py-1.5 text-right font-mono text-text-primary">
                  {a.sta_lta_ratio.toFixed(2)}
                </td>
                <td
                  className={`py-1.5 text-right font-mono font-semibold ${
                    a.confidence > 0.7 ? 'text-accent-gold' : 'text-text-primary'
                  }`}
                >
                  {a.confidence.toFixed(2)}
                </td>
              </tr>
            ))}
            {sortedArrivals.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-text-secondary">
                  暂无到时数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WaveformDisplay() {
  const stations = useAppStore((s) => s.stations);
  const fetchStations = useAppStore((s) => s.fetchStations);
  const [selectedStation, setSelectedStation] = useState<string>('');
  const [channelTraces, setChannelTraces] = useState<ChannelTrace[]>([]);
  const [staltaTraces, setStaltaTraces] = useState<StaltaTrace[]>([]);
  const [stationArrivals, setStationArrivals] = useState<PArrival[]>([]);
  const [loading, setLoading] = useState(false);
  const [staWindow, setStaWindow] = useState(0.5);
  const [ltaWindow, setLtaWindow] = useState(5.0);

  useEffect(() => {
    fetchStations();
  }, [fetchStations]);

  useEffect(() => {
    if (stations.length > 0 && !selectedStation) {
      setSelectedStation(stations[0].id);
    }
  }, [stations, selectedStation]);

  const fetchWaveformData = useCallback(async (stationId: string) => {
    if (!stationId) return;
    setLoading(true);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 30000);
      const startStr = start.toISOString();
      const endStr = end.toISOString();

      const res = await fetch(
        `${API_BASE}/waveform?station_id=${stationId}&channel=ALL&start=${startStr}&end=${endStr}`,
      );
      const data: WaveformSegment[] = await res.json();

      const channels = ['Z', 'N', 'E'];
      const traces: ChannelTrace[] = [];
      const staltaResults: StaltaTrace[] = [];

      for (const ch of channels) {
        const seg = data.find((s) => s.channel === ch);
        if (seg && seg.data.length > 0) {
          const startTime = new Date(seg.start_time).getTime() / 1000;
          const step = 1 / seg.sampling_rate;
          const times = seg.data.map((_, i) => startTime + i * step);
          traces.push({ channel: ch, times, amplitudes: seg.data });

          const staSamples = Math.round(staWindow * seg.sampling_rate);
          const ltaSamples = Math.round(ltaWindow * seg.sampling_rate);
          if (staSamples > 0 && ltaSamples > 0) {
            const ratios = computeSTA_LTA(seg.data, staSamples, ltaSamples);
            staltaResults.push({ channel: ch, times, ratios });
          }
        }
      }

      setChannelTraces(traces);
      setStaltaTraces(staltaResults);
    } catch {
      setChannelTraces([]);
      setStaltaTraces([]);
    } finally {
      setLoading(false);
    }
  }, [staWindow, ltaWindow]);

  const fetchStationArrivals = useCallback(async (stationId: string) => {
    if (!stationId) return;
    try {
      const res = await fetch(`${API_BASE}/arrivals?station_id=${stationId}`);
      const data: PArrival[] = await res.json();
      setStationArrivals(data);
    } catch {
      setStationArrivals([]);
    }
  }, []);

  useEffect(() => {
    if (!selectedStation) return;
    fetchWaveformData(selectedStation);
    fetchStationArrivals(selectedStation);
    const interval = setInterval(() => {
      fetchWaveformData(selectedStation);
      fetchStationArrivals(selectedStation);
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedStation, fetchWaveformData, fetchStationArrivals]);

  const plotData = useMemo(() => {
    const traces: Plotly.Data[] = [];
    const channelOffset = 3;

    channelTraces.forEach((trace, idx) => {
      const offset = idx * channelOffset;
      traces.push({
        x: trace.times,
        y: trace.amplitudes.map((a) => a + offset),
        type: 'scattergl' as const,
        mode: 'lines' as const,
        line: { color: '#4ADE80', width: 1 },
        name: `${selectedStation} ${trace.channel}`,
        hoverinfo: 'skip' as const,
        yaxis: 'y',
      });
    });

    staltaTraces.forEach((trace, idx) => {
      const offset = idx * channelOffset + channelOffset * channelTraces.length + channelOffset;
      traces.push({
        x: trace.times,
        y: trace.ratios.map((r) => r + offset),
        type: 'scattergl' as const,
        mode: 'lines' as const,
        line: { color: '#FACC15', width: 1, dash: 'dot' as const },
        name: `STA/LTA ${trace.channel}`,
        hoverinfo: 'skip' as const,
        yaxis: 'y',
      });
    });

    return traces;
  }, [channelTraces, staltaTraces, selectedStation]);

  const shapes = useMemo(() => {
    const channelOffset = 3;
    const allShapes: Partial<Plotly.Shape>[] = [];

    stationArrivals.forEach((a) => {
      const pickTime = new Date(a.pick_time).getTime() / 1000;
      if (channelTraces.length === 0) return;
      const minY = -1.5;
      const maxY = channelTraces.length * channelOffset + 1.5;

      allShapes.push({
        type: 'line',
        x0: pickTime,
        x1: pickTime,
        y0: minY,
        y1: maxY,
        line: { color: '#FF3D00', width: 2, dash: 'dash' as const },
        xref: 'x',
        yref: 'y',
      });
    });

    return allShapes;
  }, [stationArrivals, channelTraces]);

  const yTicks = useMemo(() => {
    const channelOffset = 3;
    const ticks: number[] = [];
    const labels: string[] = [];

    channelTraces.forEach((trace, idx) => {
      const offset = idx * channelOffset;
      ticks.push(offset);
      labels.push(`${trace.channel}`);
    });

    staltaTraces.forEach((trace, idx) => {
      const offset = idx * channelOffset + channelOffset * channelTraces.length + channelOffset;
      ticks.push(offset);
      labels.push(`S/L ${trace.channel}`);
    });

    return { ticks, labels };
  }, [channelTraces, staltaTraces]);

  const layout: Partial<Plotly.Layout> = useMemo(
    () => ({
      paper_bgcolor: '#141926',
      plot_bgcolor: '#0A0E17',
      font: { color: '#7A849B', family: 'JetBrains Mono, monospace', size: 10 },
      margin: { l: 70, r: 10, t: 10, b: 35 },
      xaxis: {
        title: { text: '时间 (s)', font: { size: 10 } },
        gridcolor: '#1A1F2E',
        zerolinecolor: '#2A3040',
        tickfont: { size: 9 },
      },
      yaxis: {
        title: { text: '通道', font: { size: 10 } },
        gridcolor: '#1A1F2E',
        zerolinecolor: '#2A3040',
        tickvals: yTicks.ticks,
        ticktext: yTicks.labels,
        tickfont: { size: 9 },
      },
      shapes,
      showlegend: false,
      autosize: true,
    }),
    [yTicks, shapes],
  );

  const plotConfig: Partial<Plotly.Config> = useMemo(
    () => ({
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['select2d', 'lasso2d'] as any,
    }),
    [],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-3">
        <Activity size={16} className="text-accent-blue" />
        <h3 className="font-mono text-sm font-semibold text-text-primary">多道波形显示</h3>
        <select
          value={selectedStation}
          onChange={(e) => setSelectedStation(e.target.value)}
          className="ml-auto rounded border border-steel-500 bg-space-800 px-3 py-1.5 font-mono text-xs text-text-primary focus:border-accent-blue focus:outline-none"
        >
          {stations.length === 0 && (
            <option value="">暂无台站</option>
          )}
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || s.id}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            if (selectedStation) {
              fetchWaveformData(selectedStation);
              fetchStationArrivals(selectedStation);
            }
          }}
          className="flex items-center gap-1 rounded border border-steel-500 bg-space-800 px-2 py-1.5 text-xs text-text-secondary transition-colors hover:border-accent-blue hover:text-accent-blue"
        >
          <RefreshCw size={12} />
          刷新
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        {loading && (
          <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded bg-space-800/80 px-2 py-1">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent-blue" />
            <span className="font-mono text-xs text-accent-blue">加载中</span>
          </div>
        )}
        <Plot
          data={plotData}
          layout={layout}
          config={plotConfig}
          useResizeHandler
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}

export default function Waveform() {
  return (
    <div className="flex h-full gap-3">
      <div className="flex-[7] min-w-0 rounded-xl border border-steel-500 bg-space-700 p-4 overflow-hidden">
        <WaveformDisplay />
      </div>
      <div className="flex-[3] min-w-0 flex flex-col gap-3 overflow-auto">
        <FilterControlPanel />
        <StaltaPanel />
        <ArrivalListPanel />
      </div>
    </div>
  );
}
