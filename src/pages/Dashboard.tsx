import { useState, useEffect, useRef, useCallback } from 'react';
import Plot from 'react-plotly.js';
import {
  Wifi,
  WifiOff,
  Server,
  Activity,
  Radio,
  Filter,
  Zap,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import type { WaveformSegment } from '@/types';

interface WaveformTrace {
  stationId: string;
  channel: string;
  times: number[];
  amplitudes: number[];
}

interface HealthStatus {
  status: string;
  uptime?: number;
  version?: string;
}

const MAX_POINTS = 1000;
const WS_URL = 'ws://localhost:8000/ws/waveform';
const HEALTH_URL = 'http://localhost:8000/health';

function StationCard({
  name,
  status,
  samplingRate,
  lastArrival,
}: {
  name: string;
  status: string;
  samplingRate: number;
  lastArrival: string;
}) {
  const isOnline = status === 'online' || status === 'active';
  return (
    <div className="rounded-lg border border-steel-500 bg-space-700 p-3 transition-colors hover:border-steel-600">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm font-medium text-text-primary">{name}</span>
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            isOnline ? 'bg-green-400 animate-pulse-dot' : 'bg-accent-red'
          }`}
          style={
            isOnline
              ? { boxShadow: '0 0 8px rgba(74,222,128,0.6)' }
              : { boxShadow: '0 0 8px rgba(255,61,0,0.4)' }
          }
        />
      </div>
      <div className="mt-2 space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-secondary">采样率</span>
          <span className="font-mono text-text-primary">{samplingRate} Hz</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-secondary">到时</span>
          <span className="font-mono text-text-primary" title={lastArrival}>
            {lastArrival ? lastArrival.slice(11, 19) : '--:--:--'}
          </span>
        </div>
      </div>
    </div>
  );
}

function StationStatusPanel() {
  const stations = useAppStore((s) => s.stations);
  const arrivals = useAppStore((s) => s.arrivals);
  const fetchStations = useAppStore((s) => s.fetchStations);
  const fetchArrivals = useAppStore((s) => s.fetchArrivals);

  useEffect(() => {
    fetchStations();
    fetchArrivals();
    const interval = setInterval(() => {
      fetchStations();
      fetchArrivals();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchStations, fetchArrivals]);

  const getLastArrival = useCallback(
    (stationId: string) => {
      const stationArrivals = arrivals
        .filter((a) => a.station_id === stationId)
        .sort((a, b) => b.pick_time.localeCompare(a.pick_time));
      return stationArrivals[0]?.pick_time ?? '';
    },
    [arrivals],
  );

  const getSamplingRate = useCallback(
    (stationId: string) => {
      const stationArrivals = arrivals.filter((a) => a.station_id === stationId);
      return stationArrivals.length > 0 ? 200 : 100;
    },
    [arrivals],
  );

  const displayStations =
    stations.length > 0
      ? stations
      : Array.from({ length: 6 }, (_, i) => ({
          id: `STA-${String(i + 1).padStart(2, '0')}`,
          name: `台站-${String(i + 1).padStart(2, '0')}`,
          latitude: 0,
          longitude: 0,
          elevation: 0,
          status: i < 4 ? 'online' : 'offline',
        }));

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <Radio size={16} className="text-accent-blue" />
        <h3 className="font-mono text-sm font-semibold text-text-primary">台站状态</h3>
        <span className="ml-auto font-mono text-xs text-text-secondary">
          {displayStations.filter((s) => s.status === 'online' || s.status === 'active').length}/
          {displayStations.length} 在线
        </span>
      </div>
      <div className="grid flex-1 auto-rows-fr grid-cols-2 gap-2">
        {displayStations.map((station) => (
          <StationCard
            key={station.id}
            name={station.name || station.id}
            status={station.status}
            samplingRate={getSamplingRate(station.id)}
            lastArrival={getLastArrival(station.id)}
          />
        ))}
      </div>
    </div>
  );
}

function WaveformPanel() {
  const [traces, setTraces] = useState<WaveformTrace[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const lastUpdateRef = useRef<number>(0);
  const pendingDataRef = useRef<WaveformSegment[]>([]);

  const connect = useCallback(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const segment: WaveformSegment = JSON.parse(event.data);
        pendingDataRef.current.push(segment);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      reconnectTimerRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [connect]);

  useEffect(() => {
    const processInterval = setInterval(() => {
      const now = Date.now();
      if (now - lastUpdateRef.current < 200) return;
      if (pendingDataRef.current.length === 0) return;

      lastUpdateRef.current = now;
      const segments = pendingDataRef.current.splice(0);

      setTraces((prev) => {
        const updated = new Map<string, WaveformTrace>();

        prev.forEach((t) => {
          const key = `${t.stationId}|${t.channel}`;
          updated.set(key, t);
        });

        for (const seg of segments) {
          const key = `${seg.station_id}|${seg.channel}`;
          const existing = updated.get(key);

          const startTime = new Date(seg.start_time).getTime() / 1000;
          const step = 1 / seg.sampling_rate;
          const rawData = seg.data;
          const downsampleRate = Math.max(1, Math.floor(rawData.length / MAX_POINTS));

          const newTimes: number[] = [];
          const newAmps: number[] = [];
          for (let i = 0; i < rawData.length; i += downsampleRate) {
            newTimes.push(startTime + i * step);
            newAmps.push(rawData[i]);
          }

          if (existing) {
            existing.times = [...existing.times, ...newTimes].slice(-MAX_POINTS * 2);
            existing.amplitudes = [...existing.amplitudes, ...newAmps].slice(-MAX_POINTS * 2);
          } else {
            updated.set(key, {
              stationId: seg.station_id,
              channel: seg.channel,
              times: newTimes,
              amplitudes: newAmps,
            });
          }
        }

        const entries = Array.from(updated.values());
        if (entries.length > 12) {
          entries.sort((a, b) => {
            if (a.times.length === 0) return 1;
            if (b.times.length === 0) return -1;
            return b.times[b.times.length - 1] - a.times[a.times.length - 1];
          });
          return entries.slice(0, 12);
        }
        return entries;
      });
    }, 200);

    return () => clearInterval(processInterval);
  }, []);

  const plotData: Plotly.Data[] = traces.map((trace, idx) => ({
    x: trace.times,
    y: trace.amplitudes.map((a) => a + idx * 2),
    type: 'scattergl' as const,
    mode: 'lines' as const,
    line: { color: '#4ADE80', width: 1 },
    name: `${trace.stationId} ${trace.channel}`,
    hoverinfo: 'skip' as const,
  }));

  const yTicks = traces.map((_, idx) => idx * 2);
  const yLabels = traces.map((t) => `${t.stationId} ${t.channel}`);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <Activity size={16} className="text-accent-blue" />
        <h3 className="font-mono text-sm font-semibold text-text-primary">波形瀑布流</h3>
        <span className="ml-auto font-mono text-xs text-text-secondary">
          {traces.length} 通道
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <Plot
          data={plotData}
          layout={{
            paper_bgcolor: '#141926',
            plot_bgcolor: '#0A0E17',
            font: { color: '#7A849B', family: 'JetBrains Mono, monospace', size: 10 },
            margin: { l: 80, r: 10, t: 10, b: 30 },
            xaxis: {
              title: { text: '时间 (s)' },
              gridcolor: '#1A1F2E',
              zerolinecolor: '#2A3040',
              tickfont: { size: 9 },
            },
            yaxis: {
              title: { text: '通道' },
              gridcolor: '#1A1F2E',
              zerolinecolor: '#2A3040',
              tickvals: yTicks,
              ticktext: yLabels,
              tickfont: { size: 8 },
            },
            showlegend: false,
            autosize: true,
          }}
          config={{
            displayModeBar: false,
            responsive: true,
          }}
          useResizeHandler
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}

function EventCounterPanel() {
  const events = useAppStore((s) => s.events);
  const fetchEvents = useAppStore((s) => s.fetchEvents);
  const prevCountRef = useRef(0);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    fetchEvents();
    const interval = setInterval(fetchEvents, 5000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  useEffect(() => {
    if (events.length > prevCountRef.current && prevCountRef.current > 0) {
      setPulsing(true);
      const timer = setTimeout(() => setPulsing(false), 600);
      return () => clearTimeout(timer);
    }
    prevCountRef.current = events.length;
  }, [events.length]);

  const now = new Date();
  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
  const bins: number[] = [];
  const binLabels: string[] = [];
  for (let i = 0; i < 10; i++) {
    const binStart = new Date(tenMinAgo.getTime() + i * 60 * 1000);
    const binEnd = new Date(binStart.getTime() + 60 * 1000);
    const count = events.filter((e) => {
      const t = new Date(e.origin_time);
      return t >= binStart && t < binEnd;
    }).length;
    bins.push(count);
    binLabels.push(binStart.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <Zap size={16} className="text-accent-blue" />
        <h3 className="font-mono text-sm font-semibold text-text-primary">微震事件</h3>
      </div>
      <div className="flex items-baseline gap-2 mb-3">
        <span
          className={`font-mono text-4xl font-bold text-accent-blue transition-all duration-300 ${
            pulsing ? 'scale-110' : 'scale-100'
          }`}
          style={pulsing ? { textShadow: '0 0 20px rgba(0,229,255,0.6)' } : {}}
        >
          {events.length}
        </span>
        <span className="text-sm text-text-secondary">事件总数</span>
      </div>
      <div className="flex-1 min-h-0">
        <Plot
          data={[
            {
              x: binLabels,
              y: bins,
              type: 'scatter',
              mode: 'lines+markers',
              line: { color: '#00E5FF', width: 2, shape: 'spline' },
              marker: { color: '#00E5FF', size: 4 },
              fill: 'tozeroy',
              fillcolor: 'rgba(0,229,255,0.1)',
              name: '事件数',
            },
          ]}
          layout={{
            paper_bgcolor: '#141926',
            plot_bgcolor: '#0A0E17',
            font: { color: '#7A849B', family: 'JetBrains Mono, monospace', size: 10 },
            margin: { l: 35, r: 10, t: 10, b: 25 },
            xaxis: {
              gridcolor: '#1A1F2E',
              tickfont: { size: 8 },
              title: { text: '' },
            },
            yaxis: {
              gridcolor: '#1A1F2E',
              zerolinecolor: '#2A3040',
              tickfont: { size: 9 },
              title: { text: '' },
              rangemode: 'tozero' as const,
            },
            showlegend: false,
            autosize: true,
          }}
          config={{ displayModeBar: false, responsive: true }}
          useResizeHandler
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}

function SystemStatusPanel() {
  const [wsConnected, setWsConnected] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const arrivals = useAppStore((s) => s.arrivals);
  const tomoRunning = useAppStore((s) => s.tomoRunning);
  const filterParams = useAppStore((s) => s.filterParams);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        setWsConnected(false);
        ws?.close();
      };
    };

    connect();
    return () => {
      ws?.close();
      clearTimeout(reconnectTimer);
    };
  }, []);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch(HEALTH_URL);
        const data = await res.json();
        setHealth(data);
      } catch {
        setHealth(null);
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  const stats = [
    {
      icon: wsConnected ? Wifi : WifiOff,
      label: 'WebSocket',
      value: wsConnected ? '已连接' : '未连接',
      color: wsConnected ? 'text-green-400' : 'text-accent-red',
    },
    {
      icon: Server,
      label: '后端状态',
      value: health?.status === 'ok' || health?.status === 'healthy' ? '正常' : '异常',
      color:
        health?.status === 'ok' || health?.status === 'healthy'
          ? 'text-green-400'
          : 'text-accent-red',
    },
    {
      icon: Activity,
      label: '到时总数',
      value: `${arrivals.length}`,
      color: 'text-accent-blue',
    },
    {
      icon: Radio,
      label: '层析状态',
      value: tomoRunning ? '运行中' : '空闲',
      color: tomoRunning ? 'text-accent-gold' : 'text-text-secondary',
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <Server size={16} className="text-accent-blue" />
        <h3 className="font-mono text-sm font-semibold text-text-primary">系统状态</h3>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {stats.map(({ icon: Icon, label, value, color }) => (
          <div
            key={label}
            className="rounded-lg border border-steel-500 bg-space-700 p-3"
          >
            <div className="flex items-center gap-1.5 mb-1">
              <Icon size={13} className={color} />
              <span className="text-xs text-text-secondary">{label}</span>
            </div>
            <span className={`font-mono text-sm font-semibold ${color}`}>{value}</span>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-steel-500 bg-space-700 p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <Filter size={13} className="text-accent-blue" />
          <span className="text-xs text-text-secondary">滤波参数</span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-text-secondary mb-0.5">低频</div>
            <div className="font-mono text-text-primary">{filterParams.freq_low} Hz</div>
          </div>
          <div>
            <div className="text-text-secondary mb-0.5">高频</div>
            <div className="font-mono text-text-primary">{filterParams.freq_high} Hz</div>
          </div>
          <div>
            <div className="text-text-secondary mb-0.5">阶数</div>
            <div className="font-mono text-text-primary">{filterParams.order}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const fetchStations = useAppStore((s) => s.fetchStations);
  const fetchEvents = useAppStore((s) => s.fetchEvents);
  const fetchArrivals = useAppStore((s) => s.fetchArrivals);

  useEffect(() => {
    fetchStations();
    fetchEvents();
    fetchArrivals();
  }, [fetchStations, fetchEvents, fetchArrivals]);

  return (
    <div className="h-full min-w-[1024px]">
      <div className="grid h-full grid-cols-3 grid-rows-2 gap-3">
        <div className="rounded-xl border border-steel-500 bg-space-700 p-4 overflow-auto">
          <StationStatusPanel />
        </div>
        <div className="col-span-2 row-span-2 rounded-xl border border-steel-500 bg-space-700 p-4 overflow-hidden">
          <WaveformPanel />
        </div>
        <div className="rounded-xl border border-steel-500 bg-space-700 p-4 overflow-auto">
          <EventCounterPanel />
        </div>
      </div>
      <div className="mt-3">
        <div className="rounded-xl border border-steel-500 bg-space-700 p-4">
          <SystemStatusPanel />
        </div>
      </div>
    </div>
  );
}
