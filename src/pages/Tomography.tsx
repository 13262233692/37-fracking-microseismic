import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Plot from 'react-plotly.js';
import type Plotly from 'plotly.js';
import { useAppStore } from '@/store/useAppStore';
import type { TomographyProgress, EventWithFocal } from '@/types';

const WS_URL = 'ws://localhost:8000/ws/tomography';

type Camera = { eye: { x: number; y: number; z: number }; center: { x: number; y: number; z: number }; up: { x: number; y: number; z: number } };

function svgToDataUrl(svg: string): string {
  const encoded = encodeURIComponent(svg)
    .replace(/'/g, '%27')
    .replace(/"/g, '%22');
  return `data:image/svg+xml;charset=utf-8,${encoded}`;
}

function project3Dto2D(
  point: { x: number; y: number; z: number },
  camera: Camera,
  ranges: { x: [number, number]; y: [number, number]; z: [number, number] },
  size: { w: number; h: number },
): { x: number; y: number; visible: boolean } {
  const cx = (ranges.x[0] + ranges.x[1]) / 2;
  const cy = (ranges.y[0] + ranges.y[1]) / 2;
  const cz = (ranges.z[0] + ranges.z[1]) / 2;
  const sx = 2 / Math.max(1e-9, ranges.x[1] - ranges.x[0]);
  const sy = 2 / Math.max(1e-9, ranges.y[1] - ranges.y[0]);
  const sz = 2 / Math.max(1e-9, ranges.z[1] - ranges.z[0]);

  const px = (point.x - cx) * sx;
  const py = (point.y - cy) * sy;
  const pz = (point.z - cz) * sz;

  const ex = camera.eye.x;
  const ey = camera.eye.y;
  const ez = camera.eye.z;
  const upx = camera.up.x;
  const upy = camera.up.y;
  const upz = camera.up.z;

  const fwd = [ex - camera.center.x, ey - camera.center.y, ez - camera.center.z];
  const fwdLen = Math.sqrt(fwd[0] ** 2 + fwd[1] ** 2 + fwd[2] ** 2) || 1;
  const fN = [fwd[0] / fwdLen, fwd[1] / fwdLen, fwd[2] / fwdLen];

  const right = [
    fN[1] * upz - fN[2] * upy,
    fN[2] * upx - fN[0] * upz,
    fN[0] * upy - fN[1] * upx,
  ];
  const rLen = Math.sqrt(right[0] ** 2 + right[1] ** 2 + right[2] ** 2) || 1;
  const rN = [right[0] / rLen, right[1] / rLen, right[2] / rLen];

  const uN = [
    rN[1] * fN[2] - rN[2] * fN[1],
    rN[2] * fN[0] - rN[0] * fN[2],
    rN[0] * fN[1] - rN[1] * fN[0],
  ];

  const vx = px - ex;
  const vy = py - ey;
  const vz = pz - ez;

  const depthVal = -(vx * fN[0] + vy * fN[1] + vz * fN[2]);
  if (depthVal <= 0.01) return { x: 0, y: 0, visible: false };

  const projX = (vx * rN[0] + vy * rN[1] + vz * rN[2]) / depthVal;
  const projY = (vx * uN[0] + vy * uN[1] + vz * uN[2]) / depthVal;

  const aspect = size.w / Math.max(1, size.h);
  const fov = 1.5;
  const screenX = (size.w / 2) * (1 + projX * fov / aspect);
  const screenY = (size.h / 2) * (1 - projY * fov);

  const pad = 20;
  const visible = screenX >= -pad && screenX <= size.w + pad && screenY >= -pad && screenY <= size.h + pad;
  return { x: screenX, y: screenY, visible };
}

export default function Tomography() {
  const {
    stations,
    events,
    eventFocalMap,
    tomoRunning,
    tomoParams,
    lastTomographyResult,
    startTomography,
    stopTomography,
    fetchLatestTomography,
    fetchEvents,
    fetchAllFocal,
  } = useAppStore();

  const [gridNx, setGridNx] = useState(tomoParams.grid_nx);
  const [gridNy, setGridNy] = useState(tomoParams.grid_ny);
  const [gridNz, setGridNz] = useState(tomoParams.grid_nz);
  const [damping, setDamping] = useState(tomoParams.damping);
  const [smoothnessWeight, setSmoothnessWeight] = useState(tomoParams.smoothness_weight);
  const [maxIter, setMaxIter] = useState(tomoParams.max_iter);
  const [convThreshold, setConvThreshold] = useState(0.001);
  const [convergenceData, setConvergenceData] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [currentRms, setCurrentRms] = useState<number | null>(null);
  const [initialRms, setInitialRms] = useState<number | null>(null);
  const [camera, setCamera] = useState<Camera>({ eye: { x: 1.5, y: 1.5, z: 1 }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } });
  const [plotSize, setPlotSize] = useState({ w: 800, h: 600 });
  const [showBeachballs, setShowBeachballs] = useState(true);
  const plotContainerRef = useRef<HTMLDivElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {};

    ws.onmessage = (event) => {
      try {
        const progress: TomographyProgress = JSON.parse(event.data);
        useAppStore.setState({ activeTomography: progress, tomoRunning: true });

        setConvergenceData((prev) => ({
          x: [...prev.x, progress.iteration],
          y: [...prev.y, progress.convergence],
        }));

        setCurrentRms(progress.rms_residual);
        if (initialRms === null && progress.iteration <= 1) {
          setInitialRms(progress.rms_residual);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      reconnectTimer.current = setTimeout(() => {
        connectWs();
      }, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [initialRms]);

  useEffect(() => {
    connectWs();
    fetchLatestTomography();
    fetchEvents();
    fetchAllFocal();

    const dataInterval = setInterval(() => {
      fetchEvents();
      fetchAllFocal();
    }, 5000);

    const updateSize = () => {
      if (plotContainerRef.current) {
        const rect = plotContainerRef.current.getBoundingClientRect();
        setPlotSize({ w: rect.width, h: rect.height });
      }
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    const sizeInterval = setInterval(updateSize, 1000);

    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      clearInterval(dataInterval);
      clearInterval(sizeInterval);
      window.removeEventListener('resize', updateSize);
    };
  }, [connectWs, fetchLatestTomography, fetchEvents, fetchAllFocal]);

  useEffect(() => {
    if (lastTomographyResult) {
      setConvergenceData({
        x: lastTomographyResult.convergence_history.map((_, i) => i + 1),
        y: lastTomographyResult.convergence_history,
      });
      setCurrentRms(lastTomographyResult.rms_residual);
      setInitialRms(
        lastTomographyResult.convergence_history.length > 0
          ? lastTomographyResult.convergence_history[0]
          : null
      );
    }
  }, [lastTomographyResult]);

  const handleStart = async () => {
    const params = {
      ...tomoParams,
      grid_nx: gridNx,
      grid_ny: gridNy,
      grid_nz: gridNz,
      damping,
      smoothness_weight: smoothnessWeight,
      max_iter: maxIter,
    };
    setConvergenceData({ x: [], y: [] });
    setCurrentRms(null);
    setInitialRms(null);
    await startTomography(params);
  };

  const handleStop = async () => {
    await stopTomography();
  };

  const buildIsosurfaceTrace = () => {
    const result = lastTomographyResult;
    if (!result || !result.velocity_model || result.velocity_model.length === 0) return [];

    const { grid_nx: nx, grid_ny: ny, grid_nz: nz, origin_lat, origin_lon, origin_depth, spacing_lat, spacing_lon, spacing_depth } = result;
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const vals: number[] = [];

    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          xs.push(origin_lon + ix * spacing_lon);
          ys.push(origin_lat + iy * spacing_lat);
          zs.push(origin_depth + iz * spacing_depth);
          vals.push(result.velocity_model[iz * ny * nx + iy * nx + ix]);
        }
      }
    }

    const meanVel = vals.reduce((a, b) => a + b, 0) / vals.length;

    return [
      {
        type: 'isosurface' as const,
        x: xs,
        y: ys,
        z: zs,
        value: vals,
        isomin: meanVel - 300,
        isomax: meanVel + 300,
        surface: { show: true, count: 3 },
        colorscale: [
          [0, '#00E5FF'] as [number, string],
          [0.5, '#FFD600'] as [number, string],
          [1, '#FF3D00'] as [number, string],
        ],
        opacity: 0.6,
        showscale: true,
        colorbar: {
          title: { text: '速度 (m/s)', font: { color: '#7A849B', size: 10 } },
          tickfont: { color: '#7A849B', size: 9 },
          bgcolor: 'rgba(0,0,0,0)',
          thickness: 15,
        },
      },
    ];
  };

  const buildStationTraces = () => {
    if (!stations || stations.length === 0) return [];
    return [
      {
        type: 'scatter3d' as const,
        mode: 'markers' as const,
        x: stations.map((s) => s.longitude),
        y: stations.map((s) => s.latitude),
        z: stations.map(() => 0),
        marker: {
          size: 5,
          color: '#FFD600',
          symbol: 'diamond' as const,
          line: { color: '#FFD600', width: 1 },
        },
        text: stations.map((s) => s.name),
        hoverinfo: 'text' as const,
        showlegend: true,
        name: '台站',
      },
    ];
  };

  const buildEventTraces = () => {
    if (!events || events.length === 0) return [];
    const focalEvents = events.filter((e) => e.id && eventFocalMap[e.id]);
    const otherEvents = events.filter((e) => !e.id || !eventFocalMap[e.id]);
    const traces: Plotly.Data[] = [];
    if (otherEvents.length > 0) {
      traces.push({
        type: 'scatter3d' as const,
        mode: 'markers' as const,
        x: otherEvents.map((e) => e.longitude),
        y: otherEvents.map((e) => e.latitude),
        z: otherEvents.map((e) => e.depth_km),
        marker: {
          size: otherEvents.map((e) => 4 + Math.max(0, e.magnitude + 1) * 3),
          color: '#9CA3AF',
          opacity: 0.7,
        },
        text: otherEvents.map((e) => `M${e.magnitude.toFixed(1)} 深度${e.depth_km.toFixed(2)}km`),
        hoverinfo: 'text' as const,
        showlegend: true,
        name: '微震事件',
      });
    }
    if (focalEvents.length > 0) {
      traces.push({
        type: 'scatter3d' as const,
        mode: 'markers' as const,
        x: focalEvents.map((e) => e.longitude),
        y: focalEvents.map((e) => e.latitude),
        z: focalEvents.map((e) => e.depth_km),
        marker: {
          size: focalEvents.map((e) => 5 + Math.max(0, e.magnitude + 1) * 3),
          color: '#FF3D00',
          opacity: 0.9,
          line: { color: '#FFD600', width: 1.5 },
        },
        text: focalEvents.map((e) => {
          const fm = e.id ? eventFocalMap[e.id]?.focal : null;
          if (!fm) return `M${e.magnitude.toFixed(1)}`;
          return `M${e.magnitude.toFixed(1)} 走向${fm.strike.toFixed(0)}° 倾角${fm.dip.toFixed(0)}° 滑动${fm.rake.toFixed(0)}°`;
        }),
        hoverinfo: 'text' as const,
        showlegend: true,
        name: '震源机制解',
      });
    }
    return traces;
  };

  const sceneRanges = useMemo(() => {
    const lons = [
      ...(stations || []).map((s) => s.longitude),
      ...(events || []).map((e) => e.longitude),
    ];
    const lats = [
      ...(stations || []).map((s) => s.latitude),
      ...(events || []).map((e) => e.latitude),
    ];
    const depths = [...(events || []).map((e) => e.depth_km), 0, 5];
    if (lastTomographyResult) {
      const r = lastTomographyResult;
      lons.push(r.origin_lon, r.origin_lon + r.grid_nx * r.spacing_lon);
      lats.push(r.origin_lat, r.origin_lat + r.grid_ny * r.spacing_lat);
      depths.push(r.origin_depth, r.origin_depth + r.grid_nz * r.spacing_depth);
    }
    const pad = (arr: number[]): [number, number] => {
      if (arr.length === 0) return [0, 1];
      const mn = Math.min(...arr);
      const mx = Math.max(...arr);
      const span = Math.max(1e-6, mx - mn);
      return [mn - span * 0.1, mx + span * 0.1];
    };
    return { x: pad(lons), y: pad(lats), z: pad(depths) };
  }, [stations, events, lastTomographyResult]);

  const focalOverlays = useMemo(() => {
    if (!showBeachballs) return [];
    const overlays: { eventId: number; x: number; y: number; svg: string; mag: number }[] = [];
    for (const e of events) {
      if (!e.id) continue;
      const focal = eventFocalMap[e.id];
      if (!focal) continue;
      const proj = project3Dto2D(
        { x: e.longitude, y: e.latitude, z: e.depth_km },
        camera,
        sceneRanges,
        plotSize,
      );
      if (!proj.visible) continue;
      overlays.push({ eventId: e.id, x: proj.x, y: proj.y, svg: focal.focal.beachball_svg, mag: e.magnitude });
    }
    return overlays;
  }, [events, eventFocalMap, camera, sceneRanges, plotSize, showBeachballs]);

  const isosurface3dLayout = useMemo(() => ({
    autosize: true,
    margin: { l: 0, r: 0, t: 30, b: 0 },
    paper_bgcolor: '#0A0E17',
    scene: {
      bgcolor: '#0A0E17',
      xaxis: { title: { text: '经度' }, color: '#7A849B', gridcolor: '#1A1F2E', zerolinecolor: '#2A3040', range: sceneRanges.x },
      yaxis: { title: { text: '纬度' }, color: '#7A849B', gridcolor: '#1A1F2E', zerolinecolor: '#2A3040', range: sceneRanges.y },
      zaxis: { title: { text: '深度 (km)' }, color: '#7A849B', gridcolor: '#1A1F2E', zerolinecolor: '#2A3040', range: sceneRanges.z },
      camera: { eye: camera.eye, center: camera.center, up: camera.up },
    },
    font: { color: '#7A849B', family: 'IBM Plex Sans' },
  }), [sceneRanges, camera]);

  const handlePlotRelayout = (eventData: Record<string, unknown>) => {
    if (eventData['scene.camera']) {
      const cam = eventData['scene.camera'] as Partial<Camera>;
      setCamera((prev) => ({
        eye: cam.eye ?? prev.eye,
        center: cam.center ?? prev.center,
        up: cam.up ?? prev.up,
      }));
    }
  };

  const convergenceLayout = {
    autosize: true,
    margin: { l: 50, r: 15, t: 30, b: 40 },
    paper_bgcolor: '#0D1120',
    plot_bgcolor: '#0D1120',
    xaxis: {
      title: { text: '迭代次数', font: { color: '#7A849B', size: 11 } },
      color: '#7A849B',
      gridcolor: '#1A1F2E',
      zerolinecolor: '#2A3040',
    },
    yaxis: {
      title: { text: '收敛值', font: { color: '#7A849B', size: 11 } },
      type: 'log' as const,
      color: '#7A849B',
      gridcolor: '#1A1F2E',
      zerolinecolor: '#2A3040',
    },
    font: { color: '#7A849B', family: 'IBM Plex Sans' },
  };

  const convergenceTrace = convergenceData.x.length > 0
    ? [
        {
          type: 'scatter' as const,
          mode: 'lines+markers' as const,
          x: convergenceData.x,
          y: convergenceData.y,
          line: { color: '#00E5FF', width: 2 },
          marker: { size: 4, color: '#00E5FF' },
        },
      ]
    : [];

  const rmsPercent = initialRms && currentRms ? Math.max(0, Math.min(100, (currentRms / initialRms) * 100)) : 0;

  return (
    <div className="flex h-full gap-3 p-3 overflow-hidden">
      <div className="flex-[65] min-w-0 flex flex-col">
        <div className="flex items-center justify-between mb-2 px-1">
          <h2 className="font-mono text-sm font-semibold text-accent-blue">三维等值面渲染</h2>
          {tomoRunning && (
            <span className="flex items-center gap-1.5 text-xs text-accent-gold">
              <span className="inline-block w-2 h-2 rounded-full bg-accent-gold animate-pulse-dot" />
              反演运行中...
            </span>
          )}
        </div>
        <div className="flex-1 rounded-lg border border-steel bg-space-800 overflow-hidden relative" ref={plotContainerRef}>
          <div className="absolute top-2 right-2 z-10 flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-text-secondary bg-space/80 px-2 py-1 rounded">
              <input
                type="checkbox"
                checked={showBeachballs}
                onChange={(e) => setShowBeachballs(e.target.checked)}
                className="accent-accent-gold"
              />
              沙滩球叠加
            </label>
          </div>
          <Plot
            data={[...buildIsosurfaceTrace(), ...buildStationTraces(), ...buildEventTraces()] as Plotly.Data[]}
            layout={isosurface3dLayout as Partial<Plotly.Layout>}
            config={{ responsive: true, displayModeBar: false }}
            style={{ width: '100%', height: '100%' }}
            onRelayout={handlePlotRelayout}
            useResizeHandler
          />
          {focalOverlays.map((ov) => {
            const sizePx = Math.max(40, Math.min(90, 50 + ov.mag * 15));
            return (
              <div
                key={`focal-${ov.eventId}`}
                className="absolute pointer-events-none"
                style={{
                  left: ov.x - sizePx / 2,
                  top: ov.y - sizePx / 2,
                  width: sizePx,
                  height: sizePx,
                  filter: 'drop-shadow(0 0 6px rgba(255, 61, 0, 0.6))',
                }}
                title={`Event #${ov.eventId} M${ov.mag.toFixed(1)}`}
              >
                <img
                  src={svgToDataUrl(ov.svg)}
                  alt={`beachball-${ov.eventId}`}
                  style={{ width: '100%', height: '100%', display: 'block' }}
                  draggable={false}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex-[35] min-w-0 flex flex-col gap-3 overflow-y-auto">
        <div className="rounded-lg border border-steel bg-space-800 p-4">
          <h3 className="font-mono text-xs font-semibold text-text-secondary mb-3">反演参数面板</h3>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1">网格 X</label>
              <input
                type="number"
                value={gridNx}
                onChange={(e) => setGridNx(Number(e.target.value))}
                className="w-full rounded border border-steel bg-space px-2 py-1 text-xs text-text-primary focus:border-accent-blue focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">网格 Y</label>
              <input
                type="number"
                value={gridNy}
                onChange={(e) => setGridNy(Number(e.target.value))}
                className="w-full rounded border border-steel bg-space px-2 py-1 text-xs text-text-primary focus:border-accent-blue focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">网格 Z</label>
              <input
                type="number"
                value={gridNz}
                onChange={(e) => setGridNz(Number(e.target.value))}
                className="w-full rounded border border-steel bg-space px-2 py-1 text-xs text-text-primary focus:border-accent-blue focus:outline-none"
              />
            </div>
          </div>

          <div className="mb-3">
            <label className="block text-xs text-text-secondary mb-1">阻尼因子</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0.001}
                max={10}
                step={0.001}
                value={damping}
                onChange={(e) => setDamping(Number(e.target.value))}
                className="flex-1 accent-accent-blue"
              />
              <input
                type="number"
                min={0.001}
                max={10}
                step={0.001}
                value={damping}
                onChange={(e) => setDamping(Number(e.target.value))}
                className="w-20 rounded border border-steel bg-space px-2 py-1 text-xs text-text-primary focus:border-accent-blue focus:outline-none"
              />
            </div>
          </div>

          <div className="mb-3">
            <label className="block text-xs text-text-secondary mb-1">光滑度权重 (Tikhonov L)</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                step={0.01}
                value={smoothnessWeight}
                onChange={(e) => setSmoothnessWeight(Number(e.target.value))}
                className="flex-1 accent-accent-gold"
              />
              <input
                type="number"
                min={0}
                max={100}
                step={0.01}
                value={smoothnessWeight}
                onChange={(e) => setSmoothnessWeight(Number(e.target.value))}
                className="w-20 rounded border border-steel bg-space px-2 py-1 text-xs text-text-primary focus:border-accent-blue focus:outline-none"
              />
            </div>
          </div>

          <div className="mb-3">
            <label className="block text-xs text-text-secondary mb-1">最大迭代次数</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={5}
                max={200}
                step={1}
                value={maxIter}
                onChange={(e) => setMaxIter(Number(e.target.value))}
                className="flex-1 accent-accent-blue"
              />
              <input
                type="number"
                min={5}
                max={200}
                step={1}
                value={maxIter}
                onChange={(e) => setMaxIter(Number(e.target.value))}
                className="w-20 rounded border border-steel bg-space px-2 py-1 text-xs text-text-primary focus:border-accent-blue focus:outline-none"
              />
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-xs text-text-secondary mb-1">收敛阈值</label>
            <input
              type="number"
              step={0.0001}
              value={convThreshold}
              onChange={(e) => setConvThreshold(Number(e.target.value))}
              className="w-full rounded border border-steel bg-space px-2 py-1 text-xs text-text-primary focus:border-accent-blue focus:outline-none"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleStart}
              disabled={tomoRunning}
              className="flex-1 rounded border border-accent-blue/30 bg-accent-blue/10 px-3 py-2 text-xs font-semibold text-accent-blue transition-all hover:bg-accent-blue/20 disabled:opacity-50"
              style={tomoRunning ? {} : { boxShadow: '0 0 12px rgba(0,229,255,0.3)' }}
            >
              启动反演
            </button>
            <button
              onClick={handleStop}
              disabled={!tomoRunning}
              className="flex-1 rounded border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-xs font-semibold text-accent-red transition-all hover:bg-accent-red/20 disabled:opacity-50"
              style={!tomoRunning ? {} : { boxShadow: '0 0 12px rgba(255,61,0,0.3)' }}
            >
              停止反演
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-steel bg-space-800 p-4">
          <h3 className="font-mono text-xs font-semibold text-text-secondary mb-2">收敛曲线</h3>
          <div className="h-48">
            <Plot
              data={convergenceTrace}
              layout={convergenceLayout}
              config={{ responsive: true, displayModeBar: false }}
              style={{ width: '100%', height: '100%' }}
            />
          </div>
        </div>

        <div className="rounded-lg border border-steel bg-space-800 p-4">
          <h3 className="font-mono text-xs font-semibold text-text-secondary mb-3">走时残差分布</h3>
          <div className="text-center mb-3">
            <span className="font-mono text-3xl font-bold text-accent-gold">
              {currentRms !== null ? currentRms.toFixed(4) : '--'}
            </span>
            <span className="ml-1 text-xs text-text-secondary">s</span>
          </div>
          {initialRms !== null && currentRms !== null && (
            <div>
              <div className="flex justify-between text-xs text-text-secondary mb-1">
                <span>残差降低</span>
                <span>{((1 - currentRms / initialRms) * 100).toFixed(1)}%</span>
              </div>
              <div className="h-2 rounded-full bg-steel overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-accent-blue to-accent-gold transition-all duration-500"
                  style={{ width: `${rmsPercent}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
