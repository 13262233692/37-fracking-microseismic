import { useState, useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Activity,
  Box,
  List,
  ChevronLeft,
  ChevronRight,
  Wifi,
  WifiOff,
} from 'lucide-react';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: '仪表盘' },
  { to: '/waveform', icon: Activity, label: '波形监测' },
  { to: '/tomography', icon: Box, label: '层析成像' },
  { to: '/events', icon: List, label: '事件列表' },
];

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      ws = new WebSocket('ws://localhost:8000/ws/arrivals');
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

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-space font-sans">
      <aside
        className={`flex flex-col border-r border-steel-500 bg-steel transition-all duration-300 ${
          collapsed ? 'w-16' : 'w-60'
        }`}
      >
        <div className="flex h-12 items-center justify-between border-b border-steel-500 px-3">
          {!collapsed && (
            <span className="font-mono text-sm font-semibold tracking-wider text-accent-blue">
              MSIS
            </span>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex h-8 w-8 items-center justify-center rounded text-text-secondary transition-colors hover:bg-steel-600 hover:text-text-primary"
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        <nav className="mt-2 flex flex-1 flex-col gap-1 px-2">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-all duration-200 ${
                  isActive
                    ? 'border-l-2 border-accent-blue bg-space-800 text-accent-blue'
                    : 'border-l-2 border-transparent text-text-secondary hover:bg-steel-600 hover:text-text-primary'
                } ${collapsed ? 'justify-center' : ''}`
              }
            >
              <Icon size={18} />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-steel-500 p-3">
          {!collapsed && (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <span className="font-mono">v1.0.0</span>
            </div>
          )}
        </div>
      </aside>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-12 items-center justify-between border-b border-steel-500 bg-space-800 px-5">
          <h1 className="font-mono text-sm font-medium tracking-wide text-text-primary">
            压裂微地震实时反演系统
          </h1>

          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2">
              {wsConnected ? (
                <>
                  <span className="animate-pulse-dot inline-block h-2 w-2 rounded-full bg-accent-blue" />
                  <Wifi size={14} className="text-accent-blue" />
                  <span className="text-xs text-accent-blue">已连接</span>
                </>
              ) : (
                <>
                  <span className="inline-block h-2 w-2 rounded-full bg-accent-red" />
                  <WifiOff size={14} className="text-accent-red" />
                  <span className="text-xs text-accent-red">未连接</span>
                </>
              )}
            </div>

            <span className="font-mono text-xs text-text-secondary">
              {currentTime.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
              })}
            </span>
          </div>
        </header>

        <main className="flex-1 overflow-auto bg-space p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
