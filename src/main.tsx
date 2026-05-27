import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Cpu,
  Database,
  Filter,
  Gauge,
  HardDrive,
  Radio,
  RefreshCw,
  Zap,
} from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  defaultDeviceTarget,
  fetchDashboardData,
  fetchServerHistory,
  getServerSession,
  login,
  normalizeDeviceTarget,
  saveServerConfig,
} from "./api";
import {
  deviceProfiles,
  resolveDeviceProfile,
  type DeviceVisualProfile,
} from "./deviceProfiles";
import {
  amps,
  formatDuration,
  kilobytes,
  milliwattHours,
  portLabel,
  protocolName,
  temperatureLevel,
  volts,
  watts,
} from "./format";
import type { ServerHistoryRow } from "./api";
import type { HeapMetrics, MachineInfo, Metrics, PortHistory, PortMetrics, TaskMetrics } from "./types";
import "./styles.css";

type DashboardData = Awaited<ReturnType<typeof fetchDashboardData>>;
const DEVICE_TARGET_STORAGE_KEY = "ionbridge:device-target:v1";
const REFRESH_INTERVAL_STORAGE_KEY = "ionbridge:refresh-interval:v1";
const DEFAULT_REFRESH_INTERVAL_MS = 30000;

function readDeviceTarget() {
  try {
    return localStorage.getItem(DEVICE_TARGET_STORAGE_KEY) ?? defaultDeviceTarget();
  } catch {
    return defaultDeviceTarget();
  }
}

function writeDeviceTarget(targetUrl: string) {
  try {
    localStorage.setItem(DEVICE_TARGET_STORAGE_KEY, targetUrl);
  } catch {
    // Non-critical. The current session still uses the configured target.
  }
}

function readRefreshInterval() {
  try {
    const stored = Number(localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 1000 ? stored : DEFAULT_REFRESH_INTERVAL_MS;
  } catch {
    return DEFAULT_REFRESH_INTERVAL_MS;
  }
}

function writeRefreshInterval(intervalMs: number) {
  try {
    localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(intervalMs));
  } catch {
    // Non-critical. The current session still uses the configured interval.
  }
}

function clampRefreshInterval(intervalMs: number) {
  return Math.max(1000, Math.min(60000, Math.round(intervalMs)));
}

function useDashboardData(targetUrl: string, refreshIntervalMs: number) {
  const [data, setData] = React.useState<DashboardData | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setData(null);
    setUpdatedAt(null);

    async function refresh() {
      const next = await fetchDashboardData(targetUrl);
      if (!alive) return;
      setData(next);
      setUpdatedAt(new Date());
    }

    refresh();
    const timer = window.setInterval(refresh, refreshIntervalMs);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [targetUrl, refreshIntervalMs, refreshToken]);

  return { data, updatedAt, retry: () => setRefreshToken((token) => token + 1) };
}

function useServerSettings() {
  const [ready, setReady] = React.useState(false);
  const [passwordRequired, setPasswordRequired] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    getServerSession().then((session) => {
      if (!alive) return;
      if (session) {
        setPasswordRequired(session.passwordEnabled && !session.authenticated);
      }
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { ready, passwordRequired, setPasswordRequired };
}

function Header({
  metrics,
  profile,
  source,
  updatedAt,
  targetUrl,
  refreshIntervalMs,
  onTargetChange,
  onRefreshIntervalChange,
}: {
  metrics: Metrics;
  profile: DeviceVisualProfile;
  source: DashboardData["source"];
  updatedAt: Date | null;
  targetUrl: string;
  refreshIntervalMs: number;
  onTargetChange: (targetUrl: string) => void;
  onRefreshIntervalChange: (refreshIntervalMs: number) => void;
}) {
  const totalPower = metrics.ports.reduce((sum, port) => sum + watts(port), 0);
  const hottest = Math.max(...metrics.ports.map((port) => port.die_temperature));
  const productTitle = profile.family === "CP02"
    ? "小电拼 CP-02 监控面板"
    : "小电拼 Mirror 监控面板";
  const productEyebrow = profile.family === "CP02"
    ? `CP-02 ${profile.variant.toUpperCase()}`
    : `${profile.family} Mirror ${profile.variant.toUpperCase()}`;

  return (
    <header className="app-header">
      <div>
        <p className="eyebrow">{productEyebrow}</p>
        <h1>{productTitle}</h1>
        <p className="subhead">
          {profile.displayKind === "amber" ? "琥珀状态屏 ingBar" : "LED 功率条"} 的全端遥测视图
        </p>
      </div>
      <div className="header-metrics" aria-label="实时摘要">
        <div className="metric-pill">
          <Zap size={17} />
          <span>{totalPower.toFixed(1)}W</span>
        </div>
        <div className={`metric-pill temp-${temperatureLevel(hottest)}`}>
          <Gauge size={17} />
          <span>{hottest}C</span>
        </div>
        <div className="metric-pill">
          <Radio size={17} />
          <span>{metrics.wifi.rssi}dBm</span>
        </div>
        <div className={`live-chip ${source}`}>
          <span />
          {source === "device" ? "Live" : "Mock"}
          {updatedAt ? ` ${updatedAt.toLocaleTimeString("zh-CN", { hour12: false })}` : ""}
        </div>
        <DeviceTargetControl
          refreshIntervalMs={refreshIntervalMs}
          targetUrl={targetUrl}
          onRefreshIntervalChange={onRefreshIntervalChange}
          onTargetChange={onTargetChange}
        />
      </div>
    </header>
  );
}

function DeviceTargetControl({
  targetUrl,
  refreshIntervalMs,
  onTargetChange,
  onRefreshIntervalChange,
}: {
  targetUrl: string;
  refreshIntervalMs: number;
  onTargetChange: (targetUrl: string) => void;
  onRefreshIntervalChange: (refreshIntervalMs: number) => void;
}) {
  const [draft, setDraft] = React.useState(targetUrl);
  const [intervalDraft, setIntervalDraft] = React.useState(String(refreshIntervalMs / 1000));

  React.useEffect(() => {
    setDraft(targetUrl);
  }, [targetUrl]);

  React.useEffect(() => {
    setIntervalDraft(String(refreshIntervalMs / 1000));
  }, [refreshIntervalMs]);

  return (
    <form
      className="target-control"
      onSubmit={(event) => {
        event.preventDefault();
        onTargetChange(normalizeDeviceTarget(draft));
        onRefreshIntervalChange(clampRefreshInterval(Number(intervalDraft) * 1000));
      }}
    >
      <input
        aria-label="设备目标地址"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="http://192.168.217.161"
      />
      <input
        aria-label="metrics 获取频率秒"
        className="interval-input"
        min="1"
        max="60"
        step="1"
        type="number"
        value={intervalDraft}
        onChange={(event) => setIntervalDraft(event.target.value)}
      />
      <span className="target-unit">s</span>
      <button type="submit">Apply</button>
    </form>
  );
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");

  return (
    <main className="login-screen">
      <form
        className="login-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            await login(password);
            onLogin();
          } catch {
            setError("密码不正确");
          }
        }}
      >
        <p>IonBridgeWeb</p>
        <h1>登录监控面板</h1>
        <input
          autoFocus
          placeholder="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit">Login</button>
        {error ? <span>{error}</span> : null}
      </form>
    </main>
  );
}

function TargetSetupScreen({
  targetUrl,
  refreshIntervalMs,
  onTargetChange,
  onRefreshIntervalChange,
  onRetry,
}: {
  targetUrl: string;
  refreshIntervalMs: number;
  onTargetChange: (targetUrl: string) => void;
  onRefreshIntervalChange: (refreshIntervalMs: number) => void;
  onRetry: () => void;
}) {
  return (
    <main className="target-setup-screen">
      <section className="target-setup-card">
        <div>
          <p>Target offline</p>
          <h1>无法连接设备</h1>
          <span>请确认设备 IP 或 mDNS 地址，保存后面板会重新拉取 metrics、历史和 Machine Info。</span>
        </div>
        <DeviceTargetControl
          refreshIntervalMs={refreshIntervalMs}
          targetUrl={targetUrl}
          onRefreshIntervalChange={onRefreshIntervalChange}
          onTargetChange={onTargetChange}
        />
        <button className="retry-button" type="button" onClick={onRetry}>
          Retry current target
        </button>
      </section>
    </main>
  );
}

function AmberScreen({
  metrics,
  history,
  profile,
}: {
  metrics: Metrics;
  history: PortHistory;
  profile: DeviceVisualProfile;
}) {
  const totalPower = metrics.ports.reduce((sum, port) => sum + watts(port), 0);
  const peakPower = Math.max(
    totalPower,
    ...history.ports.flatMap((port) => port.samples.map(samplePower)),
  );
  const percent = Math.max(0, Math.min(99, (totalPower / profile.totalPowerBudgetW) * 100));

  return (
    <div className="amber-screen" aria-label="琥珀状态屏">
      <div className="scanline" />
      <div className="amber-time">
        <span><em>NOW</em>{Math.floor(totalPower).toString().padStart(2, "0")}</span>
        <span><em>60M</em>{Math.floor(peakPower).toString().padStart(2, "0")}</span>
        <span><em>USE</em>{Math.round(percent).toString().padStart(2, "0")}</span>
      </div>
      <div className="amber-caption">W / PEAK / %</div>
      <div className="life-grid" aria-hidden="true">
        {Array.from({ length: 42 }).map((_, index) => (
          <i key={index} />
        ))}
      </div>
    </div>
  );
}

function LedStrip({ metrics, profile }: { metrics: Metrics; profile: DeviceVisualProfile }) {
  const totalPower = metrics.ports.reduce((sum, port) => sum + watts(port), 0);
  const percent = Math.max(0, Math.min(100, (totalPower / profile.totalPowerBudgetW) * 100));

  return (
    <div
      className="led-assembly"
      aria-label="LED 功率条"
      style={{ "--led-strength": `${percent / 100}`, "--led-empty": `${100 - percent}%` } as React.CSSProperties}
    >
      <div className="led-meter" aria-hidden="true">
        {Array.from({ length: 9 }).map((_, index) => (
          <i key={index} />
        ))}
      </div>
      <div className="led-strip">
        <div className="led-fill" />
      </div>
      <strong>FluxAI®</strong>
      <em>{Math.round(percent)}%</em>
    </div>
  );
}

function DeviceFace({
  metrics,
  history,
  profile,
}: {
  metrics: Metrics;
  history: PortHistory;
  profile: DeviceVisualProfile;
}) {
  const frontPorts = profile.frontPortIds
    .map((id) => metrics.ports.find((port) => port.id === id))
    .filter((port): port is PortMetrics => Boolean(port));
  const sidePorts = profile.sidePortIds
    .map((id) => metrics.ports.find((port) => port.id === id))
    .filter((port): port is PortMetrics => Boolean(port));
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageMetrics, setStageMetrics] = useState({ scale: 1, height: 0, width: 0 });
  const assetWidth = 980;

  useEffect(() => {
    const frame = frameRef.current;
    const stage = stageRef.current;
    if (!frame || !stage) {
      return undefined;
    }

    const update = () => {
      const availableWidth = frame.clientWidth;
      const scale = Math.min(1, availableWidth / assetWidth);
      const width = scale < 1 ? assetWidth : availableWidth;
      stage.style.width = `${width}px`;
      setStageMetrics({ scale, height: stage.offsetHeight, width });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [assetWidth, frontPorts.length, profile.key, sidePorts.length]);

  return (
    <section className="device-panel" aria-label="设备正面">
      <div
        ref={frameRef}
        className="device-stage-frame"
        style={{
          height: stageMetrics.height ? `${stageMetrics.height * stageMetrics.scale}px` : undefined,
        }}
      >
        <div
          ref={stageRef}
          className={`device-stage ${profile.themeClass} ${sidePorts.length === 0 ? "no-side" : ""}`}
          style={{
            transform: `scale(${stageMetrics.scale})`,
            width: stageMetrics.width ? `${stageMetrics.width}px` : undefined,
          }}
        >
          <div className="device-shell">
            <div className="brand-row">
              <MirrorLogo profile={profile} />
              <div className="candysign">CANDYSIGN</div>
            </div>
            <div className="device-main">
              <div className="indicator-slot">
                {profile.displayKind === "amber" ? (
                  <AmberScreen history={history} metrics={metrics} profile={profile} />
                ) : (
                  <LedStrip metrics={metrics} profile={profile} />
                )}
              </div>
              <div className="port-rail" style={{ "--front-ports": frontPorts.length } as React.CSSProperties}>
                <div className="rail-label">{profile.powerLabel}</div>
                {frontPorts.map((port) => (
                  <DevicePort key={port.id} port={port} />
                ))}
              </div>
            </div>
          </div>
          {sidePorts.length > 0 ? (
            <div className="side-port-dock">
              {sidePorts.map((port) => (
                <SidePortFace key={port.id} port={port} profile={profile} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function MirrorLogo({ profile }: { profile: DeviceVisualProfile }) {
  if (profile.family === "CP02") {
    return (
      <div className={`cp02-logo ${profile.variant}`}>
        <span>CP-02</span>
        <i />
        <strong>160W GaN</strong>
        <em>CoCan <b>{profile.variant === "ultra" ? "Ultra" : "Pro"}</b></em>
      </div>
    );
  }

  return (
    <div className={`mirror-logo badge-${profile.badgeStyle}`}>
      <span>CoCan</span>
      <strong>Mirror</strong>
      <em>{profile.variant === "ultra" ? "Ultra" : "Pro"}</em>
    </div>
  );
}

function DevicePort({ port }: { port: PortMetrics }) {
  const isA = port.port_type === "A";

  return (
    <div className={`device-port ${isA ? "type-a" : "type-c"} ${port.attached ? "attached" : ""}`}>
      <div className="port-hole">
        <span />
      </div>
      <strong>{portLabel(port)}</strong>
      <small>{watts(port).toFixed(1)}W</small>
    </div>
  );
}

function SidePortFace({ port, profile }: { port: PortMetrics; profile: DeviceVisualProfile }) {
  return (
    <aside className="side-port-face" aria-label="侧面 C4 端口">
      <div className="side-seam" />
      <div className="side-brand">{profile.sidePortLabel}</div>
      <DevicePort port={port} />
      <div className="side-caption">side port</div>
    </aside>
  );
}

function PortCard({ port }: { port: PortMetrics }) {
  return (
    <article className={`port-card ${temperatureLevel(port.die_temperature)} ${port.id === 4 ? "side-card" : ""}`}>
      <div className="port-card-top">
        <div>
          <p>{port.id === 4 ? "USB-C · Side" : port.port_type === "A" ? "USB-A" : "USB-C"}</p>
          <h2>{portLabel(port)}</h2>
        </div>
        <span className="state-dot">{port.attached ? "Attached" : "Idle"}</span>
      </div>
      <div className="power-number">{watts(port).toFixed(1)}W</div>
      <div className="port-grid">
        <span>{volts(port.voltage).toFixed(2)}V</span>
        <span>{amps(port.current).toFixed(2)}A</span>
        <span>{port.die_temperature}C</span>
        <span>{protocolName(port.fc_protocol)}</span>
      </div>
      <div className="budget-row">
        <span>Budget {port.power_budget}W</span>
        <span>{formatDuration(port.charging_duration_seconds)}</span>
      </div>
    </article>
  );
}

function SummaryStrip({
  metrics,
  heap,
  profile,
}: {
  metrics: Metrics;
  heap: HeapMetrics;
  profile: DeviceVisualProfile;
}) {
  const totalPower = metrics.ports.reduce((sum, port) => sum + watts(port), 0);
  const heapUsed = heap.total_allocated / (heap.total_allocated + heap.total_free);

  return (
    <section className="summary-strip">
      <SummaryItem icon={<Zap size={18} />} label="Total output" value={`${totalPower.toFixed(1)}W`} detail={`${profile.totalPowerBudgetW}W model max`} />
      <SummaryItem icon={<Gauge size={18} />} label="Thermal peak" value={`${Math.max(...metrics.ports.map((p) => p.die_temperature))}C`} detail="die temperature" />
      <SummaryItem icon={<HardDrive size={18} />} label="Heap used" value={`${Math.round(heapUsed * 100)}%`} detail={`${Math.round(heap.total_free / 1024)}KB free`} />
      <SummaryItem icon={<Cpu size={18} />} label="Runtime" value={`${Math.floor(metrics.system.boot_time_seconds / 60)}m`} detail={metrics.system.app_version} />
    </section>
  );
}

function DiagnosticsDeck({
  metrics,
  heap,
  history,
  machineInfo,
}: {
  metrics: Metrics;
  heap: HeapMetrics;
  history: PortHistory;
  machineInfo: MachineInfo;
}) {
  const [selectedPortId, setSelectedPortId] = React.useState<number | null>(null);
  const selectedPort = selectedPortId == null
    ? null
    : metrics.ports.find((port) => port.id === selectedPortId) ?? null;

  return (
    <section className="diagnostics-deck" aria-label="诊断资料">
      <div className="diagnostics-head">
        <div>
          <p>IonBridge diagnostics</p>
          <h2>设备资料与端口历史</h2>
        </div>
        <nav aria-label="诊断视图">
          <a href="#info">Info</a>
          <a href="#heap">Heap</a>
          <a href="#ports">Ports</a>
        </nav>
      </div>
      <div className="diagnostics-grid">
        <MachineInfoCard machineInfo={machineInfo} />
        <HeapCard heap={heap} />
      </div>
      <PortHistoryExplorer
        history={history}
        ports={metrics.ports}
        selectedPort={selectedPort}
        selectedPortId={selectedPortId}
        onSelectPort={setSelectedPortId}
      />
    </section>
  );
}

function MachineInfoCard({ machineInfo }: { machineInfo: MachineInfo }) {
  const rows = [
    ["PSN", machineInfo.psn],
    ["Device Model", machineInfo.device_model],
    ["Device Name", machineInfo.device_name],
    ["Product Family", machineInfo.product_family],
    ["Product Color", machineInfo.product_color],
    ["HW Rev", machineInfo.hw_rev],
    ["BLE MAC", machineInfo.ble_mac],
    ["Wi-Fi MAC", machineInfo.wifi_mac],
    ["ESP32", machineInfo.esp32_version],
    ["MCU", machineInfo.mcu_version],
    ["FPGA", machineInfo.fpga_version],
    ["ZRLib", machineInfo.zrlib_version],
    ["Country", machineInfo.country_code],
    ["mDNS", `${machineInfo.mdns_hostname}.local`],
  ];

  return (
    <article className="diagnostic-card machine-info-card" id="info">
      <div className="diagnostic-title">
        <p>Info</p>
        <h3>Machine Info</h3>
      </div>
      <dl className="machine-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function HeapCard({ heap }: { heap: HeapMetrics }) {
  const total = heap.total_allocated + heap.total_free;
  const usedPercent = total > 0 ? Math.round((heap.total_allocated / total) * 100) : 0;
  const rows = [
    ["Total Free", kilobytes(heap.total_free)],
    ["Total Allocated", kilobytes(heap.total_allocated)],
    ["Largest Free Block", kilobytes(heap.largest_free_block)],
    ["Min Free Ever", kilobytes(heap.min_free)],
    ["Allocated Blocks", heap.allocated_blocks.toString()],
    ["Free Blocks", heap.free_blocks.toString()],
    ["Total Blocks", heap.total_blocks.toString()],
  ];

  return (
    <article className="diagnostic-card heap-card" id="heap">
      <div className="diagnostic-title">
        <p>Heap</p>
        <h3>内存状态</h3>
      </div>
      <div className="heap-ring" style={{ "--heap": `${usedPercent}%` } as React.CSSProperties}>
        <strong>{usedPercent}%</strong>
        <span>used</span>
      </div>
      <dl className="machine-list compact">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function PortHistoryExplorer({
  ports,
  history,
  selectedPort,
  selectedPortId,
  onSelectPort,
}: {
  ports: PortMetrics[];
  history: PortHistory;
  selectedPort: PortMetrics | null;
  selectedPortId: number | null;
  onSelectPort: (id: number | null) => void;
}) {
  const selectedSamples = selectedPort ? getPortSamples(history, selectedPort.id) : [];
  const selectedSeries = selectedSamples.map((sample, index) => ({
    time: formatSampleTime(sample.ts, selectedSamples.length, index, history.sample_period_ms),
    power: samplePower(sample),
    temperature: sample.temperature_c ?? selectedPort?.die_temperature,
    voltage: volts(sample.voltage),
    current: amps(sample.current),
  }));
  const powers = selectedSeries.map((sample) => sample.power);
  const min = powers.length > 0 ? Math.min(...powers) : 0;
  const max = powers.length > 0 ? Math.max(...powers) : 0;
  const avg = powers.reduce((sum, power) => sum + power, 0) / Math.max(powers.length, 1);
  const coverage = getHistoryCoverageLabel(history);

  return (
    <article className="diagnostic-card port-history-card" id="ports">
      <div className="diagnostic-title split-title">
        <div>
          <p>Ports</p>
          <h3>每个端口数据与历史</h3>
        </div>
        <span>{coverage}</span>
      </div>
      <div className="port-history-grid">
        {ports.map((port) => {
          const samples = getPortSamples(history, port.id);
          return (
            <button
              className={port.id === selectedPortId ? "active" : ""}
              key={port.id}
              onClick={() => onSelectPort(port.id === selectedPortId ? null : port.id)}
              type="button"
            >
              <div className="mini-port-head">
                <strong>Port {port.id}</strong>
                <span />
              </div>
              <p>{port.id === 4 ? "USB-C · Side" : port.port_type === "A" ? "USB-A" : "USB-C"}</p>
              <div className="mono-line">
                {volts(port.voltage).toFixed(3)}V&nbsp;&nbsp;{amps(port.current).toFixed(3)}A
              </div>
              <div className="mini-power">{watts(port).toFixed(3)}W</div>
              <Sparkline samples={samples.map(samplePower)} />
              <div className="mini-footer">
                <span>POWER TREND</span>
                <strong>{watts(port).toFixed(1)}W</strong>
              </div>
            </button>
          );
        })}
      </div>

      {selectedPort ? <div className="port-detail-panel">
        <div className="port-detail-head">
          <div>
            <p>Selected</p>
            <h3>Port {selectedPort.id}</h3>
          </div>
          <span>
            {portLabel(selectedPort)} · {protocolName(selectedPort.fc_protocol)}
            {selectedPort.id === 4 ? " · Side" : ""}
          </span>
        </div>
        <ResponsiveContainer width="100%" height={230}>
          <ComposedChart data={selectedSeries} margin={{ top: 12, right: 18, left: -22, bottom: 0 }}>
            <defs>
              <linearGradient id="portDetailFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f47b20" stopOpacity={0.36} />
                <stop offset="100%" stopColor="#f47b20" stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#ded6cb" vertical />
            <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
            <YAxis yAxisId="power" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
            <YAxis
              yAxisId="temperature"
              orientation="right"
              tickLine={false}
              axisLine={false}
              tick={{ fill: "#9c4f22", fontSize: 12 }}
            />
            <Tooltip formatter={(value, name) => name === "temperature" ? `${Number(value).toFixed(0)}C` : `${Number(value).toFixed(2)}W`} />
            <Area
              dataKey="power"
              dot={false}
              fill="url(#portDetailFill)"
              isAnimationActive={false}
              stroke="#f47b20"
              strokeWidth={2.5}
              type="monotone"
              yAxisId="power"
            />
            <Line
              connectNulls
              dataKey="temperature"
              dot={false}
              isAnimationActive={false}
              name="temperature"
              stroke="#7f6d52"
              strokeDasharray="4 4"
              strokeWidth={2}
              type="monotone"
              yAxisId="temperature"
            />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="trend-stats">
          <span>Min {min.toFixed(2)}W</span>
          <span>Avg {avg.toFixed(2)}W</span>
          <span>Max {max.toFixed(2)}W</span>
        </div>
        <div className="port-detail-lists">
          <dl>
            <div>
              <dt>State</dt>
              <dd>{selectedPort.state}</dd>
            </div>
            <div>
              <dt>Protocol</dt>
              <dd>{protocolName(selectedPort.fc_protocol)} · {selectedPort.fc_protocol}</dd>
            </div>
            <div>
              <dt>Voltage</dt>
              <dd>{volts(selectedPort.voltage).toFixed(3)}V</dd>
            </div>
            <div>
              <dt>Current</dt>
              <dd>{amps(selectedPort.current).toFixed(3)}A</dd>
            </div>
            <div>
              <dt>Power</dt>
              <dd>{watts(selectedPort).toFixed(3)}W</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{formatDuration(selectedPort.charging_duration_seconds)}</dd>
            </div>
            <div>
              <dt>Session Charge</dt>
              <dd>{milliwattHours(selectedPort.session_charge)}</dd>
            </div>
          </dl>
          <dl>
            <div>
              <dt>Power Budget</dt>
              <dd>{selectedPort.power_budget}W</dd>
            </div>
            <div>
              <dt>Die Temp</dt>
              <dd>{selectedPort.die_temperature}C</dd>
            </div>
            <div>
              <dt>VIN</dt>
              <dd>{volts(selectedPort.vin_value).toFixed(2)}V</dd>
            </div>
            <div>
              <dt>Session ID</dt>
              <dd>{selectedPort.session_id}</dd>
            </div>
            <div>
              <dt>PD Status</dt>
              <dd>{selectedPort.pd_status ? "Available" : "No PD data"}</dd>
            </div>
          </dl>
        </div>
      </div> : (
        <div className="collapsed-hint">
          <span>端口详情已收起</span>
          <strong>点击任意端口展开电压、电流、协议、会话电量和 60 分钟功率曲线。</strong>
        </div>
      )}
    </article>
  );
}

function Sparkline({ samples }: { samples: number[] }) {
  const width = 180;
  const height = 58;
  if (samples.length === 0) {
    return (
      <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="端口功率趋势">
        <line x1="0" x2={width} y1="42" y2="42" />
      </svg>
    );
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = Math.max(max - min, 0.01);
  const points = samples
    .map((value, index) => {
      const x = (index / Math.max(samples.length - 1, 1)) * width;
      const y = height - ((value - min) / range) * (height - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="端口功率趋势">
      <line x1="0" x2={width} y1="18" y2="18" />
      <line x1="0" x2={width} y1="42" y2="42" />
      <polyline points={points} />
    </svg>
  );
}

function getPortSamples(history: PortHistory, portId: number) {
  return history.ports.find((port) => port.port === portId)?.samples ?? [];
}

function samplePower(sample: { voltage: number; current: number }) {
  return (sample.voltage * sample.current) / 1_000_000;
}

function getHistoryCoverageLabel(history: PortHistory) {
  const samples = Math.max(...history.ports.map((port) => port.samples.length), 0);
  const minutes = Math.round((samples * history.sample_period_ms) / 60000);
  if (minutes >= 60) return "Local 60m rolling buffer";
  if (minutes > 0) return `Device ${minutes}m + local fill`;
  return "Waiting for samples";
}

function formatSampleTime(
  ts: number | undefined,
  sampleCount: number,
  index: number,
  samplePeriodMs: number,
) {
  if (Number.isFinite(ts)) {
    return new Date(ts as number).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  return `${Math.round(((sampleCount - index - 1) * samplePeriodMs) / 60000)}m`;
}

function SummaryItem({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="summary-item">
      <div className="summary-icon">{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function ProfileSwitcher({
  activeProfile,
  detectedProfile,
  onChange,
}: {
  activeProfile: DeviceVisualProfile;
  detectedProfile: DeviceVisualProfile;
  onChange: (profile: DeviceVisualProfile) => void;
}) {
  return (
    <section className="profile-switcher" aria-label="外观主题切换">
      <div>
        <p>Appearance profile</p>
        <h2>外观主题</h2>
      </div>
      <div className="profile-options">
        {deviceProfiles.map((profile) => (
          <button
            className={profile.key === activeProfile.key ? "active" : ""}
            key={profile.key}
            onClick={() => onChange(profile)}
            type="button"
          >
            <span>{profile.family}</span>
            <strong>{profile.variant.toUpperCase()}</strong>
            {profile.key === detectedProfile.key ? <em>Detected</em> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function LongHistoryPanel({
  targetUrl,
  ports,
  updatedAt,
}: {
  targetUrl: string;
  ports: PortMetrics[];
  updatedAt: Date | null;
}) {
  const [hours, setHours] = React.useState(24);
  const [portFilter, setPortFilter] = React.useState<number | null>(null);
  const [rows, setRows] = React.useState<ServerHistoryRow[]>([]);
  const [status, setStatus] = React.useState<"loading" | "ready" | "empty" | "unavailable">("loading");

  React.useEffect(() => {
    let alive = true;
    setStatus("loading");
    fetchServerHistory({ targetUrl, hours, port: portFilter })
      .then((nextRows) => {
        if (!alive) return;
        setRows(nextRows);
        setStatus(nextRows.length > 0 ? "ready" : "empty");
      })
      .catch(() => {
        if (!alive) return;
        setRows([]);
        setStatus("unavailable");
      });
    return () => {
      alive = false;
    };
  }, [targetUrl, hours, portFilter, updatedAt?.getTime()]);

  const chartRows = React.useMemo(() => buildServerHistoryChartRows(rows), [rows]);
  const powerValues = chartRows.map((row) => row.power);
  const avgPower = powerValues.reduce((sum, value) => sum + value, 0) / Math.max(powerValues.length, 1);
  const maxPower = powerValues.length > 0 ? Math.max(...powerValues) : 0;
  const maxTemp = chartRows.length > 0 ? Math.max(...chartRows.map((row) => row.temperature)) : 0;

  return (
    <section className="panel long-history-panel">
      <div className="panel-header long-history-head">
        <div>
          <p>Server history</p>
          <h2>长时间历史与筛选</h2>
        </div>
        <div className="history-filters" aria-label="历史筛选">
          <label>
            <Filter size={15} />
            <select value={hours} onChange={(event) => setHours(Number(event.target.value))}>
              <option value={1}>1h</option>
              <option value={6}>6h</option>
              <option value={24}>24h</option>
              <option value={168}>7d</option>
              <option value={720}>30d</option>
            </select>
          </label>
          <label>
            <Database size={15} />
            <select
              value={portFilter ?? "all"}
              onChange={(event) => setPortFilter(event.target.value === "all" ? null : Number(event.target.value))}
            >
              <option value="all">All ports</option>
              {ports.map((port) => (
                <option key={port.id} value={port.id}>
                  {port.id === 4 ? "C4 Side" : portLabel(port)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {status === "ready" ? (
        <>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={chartRows} margin={{ top: 10, right: 12, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="serverHistoryFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f47b20" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#f47b20" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#e6dfd4" vertical={false} />
              <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
              <YAxis yAxisId="power" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
              <YAxis
                yAxisId="temperature"
                orientation="right"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "#9c4f22", fontSize: 12 }}
              />
              <Tooltip
                contentStyle={{ border: "1px solid #2e2823", borderRadius: 8 }}
                formatter={(value, name) => name === "temperature" ? `${Number(value).toFixed(0)}C` : `${Number(value).toFixed(2)}W`}
              />
              <Area
                dataKey="power"
                dot={false}
                fill="url(#serverHistoryFill)"
                isAnimationActive={false}
                stroke="#f47b20"
                strokeWidth={2.5}
                type="monotone"
                yAxisId="power"
              />
              <Line
                connectNulls
                dataKey="temperature"
                dot={false}
                isAnimationActive={false}
                name="temperature"
                stroke="#7f6d52"
                strokeDasharray="5 5"
                strokeWidth={2}
                type="monotone"
                yAxisId="temperature"
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="history-stats">
            <span>Samples {rows.length}</span>
            <span>Avg {avgPower.toFixed(2)}W</span>
            <span>Peak {maxPower.toFixed(2)}W</span>
            <span>Temp {maxTemp.toFixed(0)}C</span>
          </div>
        </>
      ) : (
        <div className="history-empty">
          <strong>
            {status === "loading"
              ? "正在读取服务端历史..."
              : status === "empty"
                ? "当前筛选范围还没有历史样本"
                : "当前运行模式没有可用的服务端历史"}
          </strong>
          <span>Docker/生产服务会持续写入 `/data/history`，开发模式下仍可使用设备 60 分钟历史。</span>
        </div>
      )}
    </section>
  );
}

function buildServerHistoryChartRows(rows: ServerHistoryRow[]) {
  const bucketMs = chooseHistoryBucketMs(rows);
  const buckets = new Map<number, Map<number, { power: number; temperature: number }>>();
  for (const row of rows) {
    const bucket = Math.floor(row.ts / bucketMs) * bucketMs;
    const timeline = buckets.get(bucket) ?? new Map<number, { power: number; temperature: number }>();
    const existing = timeline.get(row.ts) ?? { power: 0, temperature: 0 };
    existing.power += row.power_w;
    existing.temperature = Math.max(existing.temperature, row.temperature_c);
    timeline.set(row.ts, existing);
    buckets.set(bucket, timeline);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([ts, timeline]) => {
      const values = Array.from(timeline.values());
      return {
        time: new Date(ts).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }),
        power: values.reduce((sum, value) => sum + value.power, 0) / Math.max(values.length, 1),
        temperature: Math.max(...values.map((value) => value.temperature)),
      };
    });
}

function chooseHistoryBucketMs(rows: ServerHistoryRow[]) {
  if (rows.length < 2) return 60 * 1000;
  const span = rows[rows.length - 1].ts - rows[0].ts;
  if (span > 7 * 24 * 60 * 60 * 1000) return 60 * 60 * 1000;
  if (span > 24 * 60 * 60 * 1000) return 15 * 60 * 1000;
  if (span > 6 * 60 * 60 * 1000) return 5 * 60 * 1000;
  return 60 * 1000;
}

function PowerChart({ history }: { history: PortHistory }) {
  const basePort = history.ports.reduce(
    (longest, port) => (port.samples.length > longest.samples.length ? port : longest),
    history.ports[0],
  );
  const rows = basePort?.samples.map((_, sampleIndex) => {
    const row: Record<string, number | string> = {
      time: formatSampleTime(
        basePort.samples[sampleIndex]?.ts,
        basePort.samples.length,
        sampleIndex,
        history.sample_period_ms,
      ),
    };

    for (const port of history.ports) {
      const sample = port.samples[sampleIndex];
      row[port.port === 0 ? "A" : `C${port.port}`] = sample ? samplePower(sample) : 0;
    }
    const temperatures = history.ports
      .map((port) => port.samples[sampleIndex]?.temperature_c)
      .filter((value): value is number => Number.isFinite(value));
    row.temperature = temperatures.length > 0 ? Math.max(...temperatures) : 0;

    return row;
  }) ?? [];

  return (
    <section className="panel chart-panel">
      <div className="panel-header">
        <div>
          <p>Port timeline</p>
          <h2>实时功率与温度</h2>
        </div>
        <Activity size={20} />
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={rows} margin={{ top: 12, right: 12, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="amberFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f47b20" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#f47b20" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#e6dfd4" vertical={false} />
          <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
          <YAxis yAxisId="power" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
          <YAxis
            yAxisId="temperature"
            orientation="right"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#9c4f22", fontSize: 12 }}
          />
          <Tooltip
            contentStyle={{ border: "1px solid #2e2823", borderRadius: 8 }}
            formatter={(value, name) => name === "temperature" ? `${Number(value).toFixed(0)}C` : `${Number(value).toFixed(1)}W`}
          />
          {["A", "C1", "C2", "C3", "C4"].map((key, index) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={["#2b2926", "#f47b20", "#d9571c", "#917a54", "#6d9483"][index]}
              fill={index === 1 ? "url(#amberFill)" : "transparent"}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              yAxisId="power"
            />
          ))}
          <Line
            connectNulls
            dataKey="temperature"
            dot={false}
            isAnimationActive={false}
            name="temperature"
            stroke="#7f6d52"
            strokeDasharray="5 5"
            strokeWidth={2}
            type="monotone"
            yAxisId="temperature"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </section>
  );
}

function TaskPanel({ tasks }: { tasks: TaskMetrics[] }) {
  return (
    <section className="panel task-panel">
      <div className="panel-header">
        <div>
          <p>Runtime</p>
          <h2>任务负载</h2>
        </div>
        <Cpu size={20} />
      </div>
      <div className="task-list">
        {tasks
          .slice()
          .sort((a, b) => b.cpu_percent - a.cpu_percent)
          .map((task) => (
            <div className="task-row" key={task.name}>
              <span>{task.name}</span>
              <div className="bar">
                <i style={{ width: `${Math.min(task.cpu_percent, 100)}%` }} />
              </div>
              <strong>{task.cpu_percent.toFixed(2)}%</strong>
            </div>
          ))}
      </div>
    </section>
  );
}

function SystemPanel({ metrics, heap }: { metrics: Metrics; heap: HeapMetrics }) {
  return (
    <section className="panel system-panel">
      <div className="panel-header">
        <div>
          <p>Device</p>
          <h2>系统状态</h2>
        </div>
        <RefreshCw size={20} />
      </div>
      <dl>
        <div>
          <dt>Chip</dt>
          <dd>{metrics.system.chip} · {metrics.system.cpu_freq_mhz}MHz</dd>
        </div>
        <div>
          <dt>IDF</dt>
          <dd>{metrics.system.idf_version}</dd>
        </div>
        <div>
          <dt>Wi-Fi</dt>
          <dd>{metrics.wifi.ssid} · ch {metrics.wifi.channel}</dd>
        </div>
        <div>
          <dt>BSSID</dt>
          <dd>{metrics.wifi.bssid}</dd>
        </div>
        <div>
          <dt>Heap</dt>
          <dd>{Math.round(heap.total_free / 1024)}KB free · {heap.allocated_blocks} blocks</dd>
        </div>
      </dl>
    </section>
  );
}

function RuntimePanel({ metrics, heap }: { metrics: Metrics; heap: HeapMetrics }) {
  return (
    <section className="panel runtime-panel">
      <SystemPanel metrics={metrics} heap={heap} />
      <TaskPanel tasks={metrics.tasks} />
    </section>
  );
}

function App() {
  const [targetUrl, setTargetUrl] = React.useState(readDeviceTarget);
  const [refreshIntervalMs, setRefreshIntervalMs] = React.useState(readRefreshInterval);
  const { ready, passwordRequired, setPasswordRequired } = useServerSettings();
  const { data, updatedAt, retry } = useDashboardData(targetUrl, refreshIntervalMs);
  const [activeProfileKey, setActiveProfileKey] = React.useState<string | null>(null);

  async function handleTargetChange(nextTargetUrl: string) {
    setTargetUrl(nextTargetUrl);
    setActiveProfileKey(null);
    writeDeviceTarget(nextTargetUrl);
    try {
      await saveServerConfig({ targetUrl: nextTargetUrl, refreshIntervalMs });
    } catch {
      // Dev-server fallback. Vite proxy still uses the local control value.
    }
  }

  async function handleRefreshIntervalChange(nextRefreshIntervalMs: number) {
    const clamped = clampRefreshInterval(nextRefreshIntervalMs);
    setRefreshIntervalMs(clamped);
    writeRefreshInterval(clamped);
    try {
      await saveServerConfig({ targetUrl, refreshIntervalMs: clamped });
    } catch {
      // Dev-server fallback. Local polling still uses the configured interval.
    }
  }

  React.useEffect(() => {
    getServerSession().then((session) => {
      if (!session || !session.authenticated) return;
      const serverTarget = normalizeDeviceTarget(session.config.targetUrl);
      const serverInterval = clampRefreshInterval(session.config.refreshIntervalMs);
      setTargetUrl(serverTarget);
      setRefreshIntervalMs(serverInterval);
      writeDeviceTarget(serverTarget);
      writeRefreshInterval(serverInterval);
    });
  }, [passwordRequired]);

  if (!ready) {
    return <main className="loading">ingBar warming up...</main>;
  }

  if (passwordRequired) {
    return <LoginScreen onLogin={() => setPasswordRequired(false)} />;
  }

  if (!data) {
    return <main className="loading">ingBar warming up... {targetUrl}</main>;
  }

  const { metrics, history, heap, machineInfo, source } = data;
  if (source === "mock") {
    return (
      <TargetSetupScreen
        refreshIntervalMs={refreshIntervalMs}
        targetUrl={targetUrl}
        onRefreshIntervalChange={handleRefreshIntervalChange}
        onRetry={retry}
        onTargetChange={handleTargetChange}
      />
    );
  }

  const detectedProfile = resolveDeviceProfile(machineInfo, metrics.ports);
  const activeProfile =
    deviceProfiles.find((profile) => profile.key === (activeProfileKey ?? detectedProfile.key)) ??
    detectedProfile;

  return (
    <main className="app">
      <Header
        metrics={metrics}
        profile={activeProfile}
        source={source}
        targetUrl={targetUrl}
        refreshIntervalMs={refreshIntervalMs}
        updatedAt={updatedAt}
        onRefreshIntervalChange={handleRefreshIntervalChange}
        onTargetChange={handleTargetChange}
      />
      <ProfileSwitcher
        activeProfile={activeProfile}
        detectedProfile={detectedProfile}
        onChange={(profile) => setActiveProfileKey(profile.key)}
      />
      <DeviceFace history={history} metrics={metrics} profile={activeProfile} />
      <SummaryStrip heap={heap} metrics={metrics} profile={activeProfile} />
      <section className="ports-grid" aria-label="端口遥测">
        {metrics.ports.map((port) => (
          <PortCard key={port.id} port={port} />
        ))}
      </section>
      <section className="dashboard-grid">
        <PowerChart history={history} />
        <RuntimePanel metrics={metrics} heap={heap} />
      </section>
      <LongHistoryPanel targetUrl={targetUrl} ports={metrics.ports} updatedAt={updatedAt} />
      <DiagnosticsDeck heap={heap} history={history} machineInfo={machineInfo} metrics={metrics} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
