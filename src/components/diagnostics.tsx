import React from "react";
import { Filter } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { fetchServerHistory, type ServerHistoryRow } from "../api";
import { amps, formatDuration, kilobytes, milliwattHours, portLabel, protocolName, temperatureLevel, volts, watts } from "../format";
import { useI18n, type TranslationKey } from "../i18n";
import type { HeapMetrics, MachineInfo, Metrics, PortHistory, PortMetrics } from "../types";

function formatDateTimeLocal(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDateTimeLocal(value: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

export function DiagnosticsDeck({
  metrics,
  heap,
  history,
  machineInfo,
  targetUrl,
}: {
  metrics: Metrics;
  heap: HeapMetrics;
  history: PortHistory;
  machineInfo: MachineInfo;
  targetUrl: string;
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = React.useState<"info" | "heap" | "ports">("ports");
  const [selectedPortId, setSelectedPortId] = React.useState<number | null>(null);
  const selectedPort = selectedPortId == null
    ? null
    : metrics.ports.find((port) => port.id === selectedPortId) ?? null;

  return (
    <section className="diagnostics-deck" aria-label={t("diagnosticsAria")}>
      <div className="diagnostics-head">
        <div>
          <p>{t("diagnostics")}</p>
          <h2>{t("diagnosticsTitle")}</h2>
        </div>
        <nav className="diagnostics-tabs" aria-label={t("diagnosticsTabs")}>
          {[
            ["info", t("tabDevice")],
            ["heap", t("tabHeap")],
            ["ports", t("tabPorts")],
          ].map(([key, label]) => (
            <button
              aria-selected={activeTab === key}
              className={activeTab === key ? "active" : ""}
              key={key}
              onClick={() => setActiveTab(key as "info" | "heap" | "ports")}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="diagnostics-tab-panel" role="tabpanel">
        {activeTab === "info" ? <MachineInfoCard machineInfo={machineInfo} /> : null}
        {activeTab === "heap" ? <HeapCard heap={heap} /> : null}
        {activeTab === "ports" ? (
          <PortHistoryExplorer
            history={history}
            ports={metrics.ports}
            selectedPort={selectedPort}
            selectedPortId={selectedPortId}
            targetUrl={targetUrl}
            onSelectPort={setSelectedPortId}
          />
        ) : null}
      </div>
    </section>
  );
}

function MachineInfoCard({ machineInfo }: { machineInfo: MachineInfo }) {
  const { t } = useI18n();
  const rows = [
    ["PSN", machineInfo.psn],
    [t("deviceModel"), machineInfo.device_model],
    [t("deviceName"), machineInfo.device_name],
    [t("productFamily"), machineInfo.product_family],
    [t("productColor"), machineInfo.product_color],
    [t("hwRev"), machineInfo.hw_rev],
    ["BLE MAC", machineInfo.ble_mac],
    ["Wi-Fi MAC", machineInfo.wifi_mac],
    ["ESP32", machineInfo.esp32_version],
    ["MCU", machineInfo.mcu_version],
    ["FPGA", machineInfo.fpga_version],
    ["ZRLib", machineInfo.zrlib_version],
    [t("country"), machineInfo.country_code],
    ["mDNS", `${machineInfo.mdns_hostname}.local`],
  ];

  return (
    <article className="diagnostic-card machine-info-card" id="info">
      <div className="diagnostic-title">
        <p>{t("tabDevice")}</p>
        <h3>{t("machineInfo")}</h3>
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
  const { t } = useI18n();
  const total = heap.total_allocated + heap.total_free;
  const usedPercent = total > 0 ? Math.round((heap.total_allocated / total) * 100) : 0;
  const rows = [
    [t("heapFree"), kilobytes(heap.total_free)],
    [t("heapAllocated"), kilobytes(heap.total_allocated)],
    [t("heapLargestFree"), kilobytes(heap.largest_free_block)],
    [t("heapMinFree"), kilobytes(heap.min_free)],
    [t("heapAllocatedBlocks"), heap.allocated_blocks.toString()],
    [t("heapFreeBlocks"), heap.free_blocks.toString()],
    [t("heapTotalBlocks"), heap.total_blocks.toString()],
  ];

  return (
    <article className="diagnostic-card heap-card" id="heap">
      <div className="diagnostic-title">
        <p>{t("tabHeap")}</p>
        <h3>{t("heapStatus")}</h3>
      </div>
      <div className="heap-ring" style={{ "--heap": `${usedPercent}%` } as React.CSSProperties}>
        <strong>{usedPercent}%</strong>
        <span>{t("heapUsedShort")}</span>
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
  targetUrl,
  onSelectPort,
}: {
  ports: PortMetrics[];
  history: PortHistory;
  selectedPort: PortMetrics | null;
  selectedPortId: number | null;
  targetUrl: string;
  onSelectPort: (id: number | null) => void;
}) {
  const { t } = useI18n();
  const now = React.useMemo(() => new Date(), []);
  const [hours, setHours] = React.useState(1);
  const [rangeMode, setRangeMode] = React.useState<"preset" | "custom">("preset");
  const [customStart, setCustomStart] = React.useState(formatDateTimeLocal(new Date(now.getTime() - 60 * 60 * 1000)));
  const [customEnd, setCustomEnd] = React.useState(formatDateTimeLocal(now));
  const [serverRows, setServerRows] = React.useState<ServerHistoryRow[]>([]);
  const [serverStatus, setServerStatus] = React.useState<"idle" | "loading" | "ready" | "empty" | "unavailable">("idle");
  const start = rangeMode === "custom" ? parseDateTimeLocal(customStart) : undefined;
  const end = rangeMode === "custom" ? parseDateTimeLocal(customEnd) : undefined;
  const canQuery = selectedPortId != null && (rangeMode === "preset" || (start != null && end != null && start <= end));

  React.useEffect(() => {
    let alive = true;
    if (!canQuery || selectedPortId == null) {
      setServerRows([]);
      setServerStatus("idle");
      return () => {
        alive = false;
      };
    }
    setServerStatus("loading");
    fetchServerHistory({
      targetUrl,
      hours: rangeMode === "preset" ? hours : undefined,
      start,
      end,
      port: selectedPortId,
    })
      .then((nextRows) => {
        if (!alive) return;
        setServerRows(nextRows);
        setServerStatus(nextRows.length > 0 ? "ready" : "empty");
      })
      .catch(() => {
        if (!alive) return;
        setServerRows([]);
        setServerStatus("unavailable");
      });
    return () => {
      alive = false;
    };
  }, [targetUrl, selectedPortId, hours, rangeMode, customStart, customEnd, canQuery, start, end]);

  const selectedSamples = selectedPort ? getPortSamples(history, selectedPort.id) : [];
  const localSeries = selectedSamples.map((sample, index) => ({
    time: formatSampleTime(sample.ts, selectedSamples.length, index, history.sample_period_ms),
    power: samplePower(sample),
    temperature: validTemperature(sample.temperature_c) ?? validTemperature(selectedPort?.die_temperature),
    voltage: volts(sample.voltage),
    current: amps(sample.current),
  }));
  const serverSeries = serverRows.map((row) => ({
    time: new Date(row.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    power: row.power_w,
    temperature: validTemperature(row.temperature_c) ?? validTemperature(selectedPort?.die_temperature),
    voltage: volts(row.voltage),
    current: amps(row.current),
  }));
  const selectedSeries = serverSeries.length > 0 ? serverSeries : localSeries;
  const powers = selectedSeries.map((sample) => sample.power);
  const min = powers.length > 0 ? Math.min(...powers) : 0;
  const max = powers.length > 0 ? Math.max(...powers) : 0;
  const avg = powers.reduce((sum, power) => sum + power, 0) / Math.max(powers.length, 1);
  const coverage = getHistoryCoverageLabel(history, t);

  return (
    <article className="diagnostic-card port-history-card" id="ports">
      <div className="diagnostic-title split-title">
        <div>
          <p>{t("tabPorts")}</p>
          <h3>{t("perPortHistory")}</h3>
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
                <strong>{portLabel(port)}</strong>
                <span />
              </div>
              <p>{port.id === 4 ? `USB-C · ${t("sideSuffix")}` : port.port_type === "A" ? "USB-A" : "USB-C"}</p>
              <div className="mono-line">
                {volts(port.voltage).toFixed(3)}V&nbsp;&nbsp;{amps(port.current).toFixed(3)}A
              </div>
              <div className="mini-power">{watts(port).toFixed(3)}W</div>
              <Sparkline samples={samples.map(samplePower)} />
              <div className="mini-footer">
                <span>{t("powerTrend")}</span>
                <strong>{watts(port).toFixed(1)}W</strong>
              </div>
            </button>
          );
        })}
      </div>

      {selectedPort ? <div className="port-detail-panel">
        <div className="port-detail-head">
          <div>
            <p>{t("selected")}</p>
            <h3>{portLabel(selectedPort)}</h3>
          </div>
          <span>
            {portLabel(selectedPort)} · {protocolName(selectedPort.fc_protocol)}
            {selectedPort.id === 4 ? ` · ${t("sideSuffix")}` : ""}
          </span>
        </div>
        <div className="history-filters port-history-filters" aria-label={t("historyFilters")}>
          <label>
            <Filter size={15} />
            <select value={rangeMode} onChange={(event) => setRangeMode(event.target.value as "preset" | "custom")}>
              <option value="preset">{t("preset")}</option>
              <option value="custom">{t("custom")}</option>
            </select>
          </label>
          {rangeMode === "preset" ? <label>
            <select value={hours} onChange={(event) => setHours(Number(event.target.value))}>
              <option value={1}>1h</option>
              <option value={6}>6h</option>
              <option value={24}>24h</option>
              <option value={168}>7d</option>
              <option value={720}>30d</option>
            </select>
          </label> : <>
            <label className="datetime-filter">
              <span>{t("from")}</span>
              <input type="datetime-local" value={customStart} onChange={(event) => setCustomStart(event.target.value)} />
            </label>
            <label className="datetime-filter">
              <span>{t("to")}</span>
              <input type="datetime-local" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} />
            </label>
          </>}
          <span className="panel-note">
            {serverStatus === "loading"
              ? t("readingHistory")
              : serverStatus === "ready"
                ? `${t("samples")} ${serverRows.length}`
                : serverStatus === "empty"
                  ? t("local60m")
                  : serverStatus === "unavailable"
                    ? t("unavailableHistory")
                    : t("local60m")}
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
            <Tooltip formatter={(value, name) => name === "temperature" ? formatTemperatureTooltip(value) : `${Number(value).toFixed(2)}W`} />
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
          <span>{t("min")} {min.toFixed(2)}W</span>
          <span>{t("avg")} {avg.toFixed(2)}W</span>
          <span>{t("max")} {max.toFixed(2)}W</span>
        </div>
        <div className="port-va-charts">
          <MetricTrendChart
            color="#2f806c"
            data={selectedSeries}
            dataKey="voltage"
            title={`${t("voltage")} (V)`}
            unit="V"
          />
          <MetricTrendChart
            color="#6f5aa8"
            data={selectedSeries}
            dataKey="current"
            title={`${t("current")} (A)`}
            unit="A"
          />
        </div>
        <div className="port-detail-lists">
          <dl>
            <div>
              <dt>{t("state")}</dt>
              <dd>{selectedPort.state}</dd>
            </div>
            <div>
              <dt>{t("protocol")}</dt>
              <dd>{protocolName(selectedPort.fc_protocol)} · {selectedPort.fc_protocol}</dd>
            </div>
            <div>
              <dt>{t("voltage")}</dt>
              <dd>{volts(selectedPort.voltage).toFixed(3)}V</dd>
            </div>
            <div>
              <dt>{t("current")}</dt>
              <dd>{amps(selectedPort.current).toFixed(3)}A</dd>
            </div>
            <div>
              <dt>{t("power")}</dt>
              <dd>{watts(selectedPort).toFixed(3)}W</dd>
            </div>
            <div>
              <dt>{t("session")}</dt>
              <dd>{formatDuration(selectedPort.charging_duration_seconds)}</dd>
            </div>
            <div>
              <dt>{t("sessionCharge")}</dt>
              <dd>{milliwattHours(selectedPort.session_charge)}</dd>
            </div>
          </dl>
          <dl>
            <div>
              <dt>{t("portLimit")}</dt>
              <dd>{selectedPort.power_budget}W</dd>
            </div>
            <div>
              <dt>{t("portTemp")}</dt>
              <dd>{selectedPort.die_temperature}C</dd>
            </div>
            <div>
              <dt>VIN</dt>
              <dd>{volts(selectedPort.vin_value).toFixed(2)}V</dd>
            </div>
            <div>
              <dt>{t("sessionId")}</dt>
              <dd>{selectedPort.session_id}</dd>
            </div>
            <div>
              <dt>{t("pdStatus")}</dt>
              <dd>{selectedPort.pd_status ? t("pdAvailable") : t("noPdData")}</dd>
            </div>
          </dl>
        </div>
      </div> : (
        <div className="collapsed-hint">
          <span>{t("collapsed")}</span>
          <strong>{t("collapsedHint")}</strong>
        </div>
      )}
    </article>
  );
}

function MetricTrendChart({
  color,
  data,
  dataKey,
  title,
  unit,
}: {
  color: string;
  data: Array<{ time: string; voltage?: number | string | null; current?: number | string | null }>;
  dataKey: "voltage" | "current";
  title: string;
  unit: string;
}) {
  return (
    <div className="metric-trend-card">
      <h4>{title}</h4>
      <ResponsiveContainer width="100%" height={150}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: -24, bottom: 0 }}>
          <CartesianGrid stroke="#e6dfd4" vertical={false} />
          <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 11 }} />
          <YAxis domain={["auto", "auto"]} tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 11 }} />
          <Tooltip formatter={(value) => `${Number(value).toFixed(3)}${unit}`} />
          <Line
            connectNulls
            dataKey={dataKey}
            dot={false}
            isAnimationActive={false}
            stroke={color}
            strokeWidth={2.25}
            type="monotone"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MultiMetricTrendChart({
  colors,
  data,
  keys,
  labels,
  title,
  unit,
}: {
  colors: string[];
  data: Array<Record<string, number | string | null> & { time: string }>;
  keys: string[];
  labels: string[];
  title: string;
  unit: string;
}) {
  return (
    <div className="metric-trend-card">
      <h4>{title}</h4>
      <ResponsiveContainer width="100%" height={150}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: -24, bottom: 0 }}>
          <CartesianGrid stroke="#e6dfd4" vertical={false} />
          <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 11 }} />
          <YAxis domain={["auto", "auto"]} tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 11 }} />
          <Tooltip formatter={(value, name) => [`${Number(value).toFixed(3)}${unit}`, String(name).replace(/[VA]$/, "")]} />
          {keys.map((key, index) => (
            <Line
              connectNulls
              dataKey={key}
              dot={false}
              isAnimationActive={false}
              key={key}
              name={labels[index]}
              stroke={colors[index]}
              strokeWidth={2}
              type="monotone"
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Sparkline({ samples }: { samples: number[] }) {
  const { t } = useI18n();
  const width = 180;
  const height = 58;
  if (samples.length === 0) {
    return (
      <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("powerTrend")}>
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
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("powerTrend")}>
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

function validTemperature(value: number | undefined | null) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}

function maxValidTemperature(values: Array<number | null | undefined>) {
  const valid = values.map(validTemperature).filter((value): value is number => value != null);
  return valid.length > 0 ? Math.max(...valid) : null;
}

function formatTemperatureTooltip(value: unknown) {
  return typeof value === "number" && value > 0 ? `${value.toFixed(0)}C` : "N/A";
}

function getHistoryCoverageLabel(history: PortHistory, t: (key: TranslationKey) => string) {
  const samples = Math.max(...history.ports.map((port) => port.samples.length), 0);
  const minutes = Math.round((samples * history.sample_period_ms) / 60000);
  if (minutes >= 60) return t("local60m");
  if (minutes > 0) return `${t("deviceMinutesPrefix")} ${minutes}${t("deviceMinutesSuffix")}`;
  return t("waitingSamples");
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
