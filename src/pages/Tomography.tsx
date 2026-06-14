import { useState, useEffect, useRef, useCallback } from 'react';
import Plot from 'react-plotly.js';
import type Plotly from 'plotly.js';
import { useAppStore } from '@/store/useAppStore';
import type { TomographyProgress } from '@/types';

const WS_URL = 'ws://localhost:8000/ws/tomography';

export default function Tomography() {
  const {
    stations,
    tomoRunning,
    tomoParams,
    lastTomographyResult,
    startTomography,
    stopTomography,
    fetchLatestTomography,
  } = useAppStore();

  const [gridNx, setGridNx] = useState(tomoParams.grid_nx);
  const [gridNy, setGridNy] = useState(tomoParams.grid_ny);
  const [gridNz, setGridNz] = useState(tomoParams.grid_nz);
  const [damping, setDamping] = useState(tomoParams.damping);
  const [maxIter, setMaxIter] = useState(tomoParams.max_iter);
  const [convThreshold, setConvThreshold] = useState(0.001);
  const [convergenceData, setConvergenceData] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [currentRms, setCurrentRms] = useState<number | null>(null);
  const [initialRms, setInitialRms] = useState<number | null>(null);

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

    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connectWs, fetchLatestTomography]);

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

  const isosurface3dLayout = {
    autosize: true,
    margin: { l: 0, r: 0, t: 30, b: 0 },
    paper_bgcolor: '#0A0E17',
    scene: {
      bgcolor: '#0A0E17',
      xaxis: { title: { text: '经度' }, color: '#7A849B', gridcolor: '#1A1F2E', zerolinecolor: '#2A3040' },
      yaxis: { title: { text: '纬度' }, color: '#7A849B', gridcolor: '#1A1F2E', zerolinecolor: '#2A3040' },
      zaxis: { title: { text: '深度 (km)' }, color: '#7A849B', gridcolor: '#1A1F2E', zerolinecolor: '#2A3040' },
      camera: { eye: { x: 1.5, y: 1.5, z: 1 } },
    },
    font: { color: '#7A849B', family: 'IBM Plex Sans' },
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
        <div className="flex-1 rounded-lg border border-steel bg-space-800 overflow-hidden">
          <Plot
            data={[...buildIsosurfaceTrace(), ...buildStationTraces()] as Plotly.Data[]}
            layout={isosurface3dLayout as Partial<Plotly.Layout>}
            config={{ responsive: true, displayModeBar: false }}
            style={{ width: '100%', height: '100%' }}
          />
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
