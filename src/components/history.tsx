import React from "react";
import { Activity, Database, Filter } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { fetchServerHistory, type ServerHistoryRow } from "../api";
import { MultiMetricTrendChart } from "./diagnostics";
import { amps, portLabel, volts, watts } from "../format";
import { useI18n, type TranslationKey } from "../i18n";
import type { Metrics, PortHistory, PortMetrics } from "../types";
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

function formatPowerTooltip(value: unknown) {
  return typeof value === "number" ? `${value.toFixed(2)}W` : "N/A";
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

export function LongHistoryPanel({
  targetUrl,
  deviceKey,
  isLive,
  metrics,
  ports,
  updatedAt,
}: {
  targetUrl: string;
  deviceKey?: string | null;
  isLive: boolean;
  metrics: Metrics;
  ports: PortMetrics[];
  updatedAt: Date | null;
}) {
  const { t } = useI18n();
  const now = React.useMemo(() => new Date(), []);
  const [hours, setHours] = React.useState(24);
  const [rangeMode, setRangeMode] = React.useState<"preset" | "custom">("preset");
  const [customStart, setCustomStart] = React.useState(formatDateTimeLocal(new Date(now.getTime() - 24 * 60 * 60 * 1000)));
  const [customEnd, setCustomEnd] = React.useState(formatDateTimeLocal(now));
  const [portFilter, setPortFilter] = React.useState<number | null>(null);
  const [rows, setRows] = React.useState<ServerHistoryRow[]>([]);
  const [status, setStatus] = React.useState<"loading" | "ready" | "empty" | "unavailable">("loading");
  const [loadedAt, setLoadedAt] = React.useState<Date | null>(null);
  const start = rangeMode === "custom" ? parseDateTimeLocal(customStart) : undefined;
  const end = rangeMode === "custom" ? parseDateTimeLocal(customEnd) : undefined;
  const canQuery = rangeMode === "preset" || (start != null && end != null && start <= end);

  React.useEffect(() => {
    let alive = true;
    if (!canQuery) {
      setRows([]);
      setLoadedAt(null);
      setStatus("empty");
      return () => {
        alive = false;
      };
    }
    setStatus("loading");
    fetchServerHistory({
      targetUrl,
      deviceKey,
      hours: rangeMode === "preset" ? hours : undefined,
      start,
      end,
      port: portFilter,
    })
      .then((nextRows) => {
        if (!alive) return;
        setRows(nextRows);
        setLoadedAt(new Date());
        setStatus(nextRows.length > 0 ? "ready" : "empty");
      })
      .catch(() => {
        if (!alive) return;
        setRows([]);
        setLoadedAt(null);
        setStatus("unavailable");
      });
    return () => {
      alive = false;
    };
  }, [targetUrl, deviceKey, hours, rangeMode, customStart, customEnd, portFilter, canQuery, start, end]);

  React.useEffect(() => {
    if (!isLive || !updatedAt || !canQuery) return;
    const ts = updatedAt.getTime();
    const rangeStart = rangeMode === "custom" ? start : Date.now() - hours * 60 * 60 * 1000;
    const rangeEnd = rangeMode === "custom" ? end : Date.now() + 1000;
    if (rangeStart == null || rangeEnd == null || ts < rangeStart || ts > rangeEnd) return;
    const nextLiveRows = metrics.ports
      .filter((port) => portFilter == null || port.id === portFilter)
      .map((port) => ({
        ts,
        target: targetUrl,
        port: port.id,
        voltage: port.voltage,
        current: port.current,
        temperature_c: port.die_temperature,
        power_w: watts(port),
        attached: port.attached,
        protocol: String(port.fc_protocol),
      }));
    setRows((currentRows) => {
      const merged = [...currentRows.filter((row) => row.ts >= rangeStart && row.ts <= rangeEnd), ...nextLiveRows];
      const bySample = new Map<string, ServerHistoryRow>();
      for (const row of merged) bySample.set(`${row.ts}:${row.port}`, row);
      return Array.from(bySample.values()).sort((a, b) => a.ts - b.ts || a.port - b.port);
    });
    setLoadedAt(new Date());
    setStatus((currentStatus) => currentStatus === "unavailable" ? currentStatus : "ready");
  }, [targetUrl, isLive, metrics, hours, rangeMode, portFilter, updatedAt, canQuery, start, end]);

  const chartRows = React.useMemo(() => buildServerHistoryChartRows(rows), [rows]);
  const powerValues = chartRows.map((row) => row.power).filter((value): value is number => typeof value === "number");
  const avgPower = powerValues.reduce((sum, value) => sum + value, 0) / Math.max(powerValues.length, 1);
  const maxPower = powerValues.length > 0 ? Math.max(...powerValues) : 0;
  const maxTemp = maxValidTemperature(chartRows.map((row) => row.temperature));
  const canShowChart = status === "ready" || (status === "loading" && rows.length > 0);

  return (
    <section className="panel long-history-panel" id="history" aria-busy={status === "loading"}>
      <div className="panel-header long-history-head">
        <div>
          <p>{t("serverHistory")}</p>
          <h2>{t("longHistory")}</h2>
          <span className="panel-note">
            {t("autoRefreshPrefix")}{loadedAt ? ` · ${loadedAt.toLocaleTimeString("zh-CN", { hour12: false })}` : ""}
          </span>
        </div>
        <div className="history-filters" aria-label={t("historyFilters")}>
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
          <label>
            <Database size={15} />
            <select
              value={portFilter ?? "all"}
              onChange={(event) => setPortFilter(event.target.value === "all" ? null : Number(event.target.value))}
            >
              <option value="all">{t("allPorts")}</option>
              {ports.map((port) => (
                <option key={port.id} value={port.id}>
                  {port.id === 4 ? `C4 ${t("sideSuffix")}` : portLabel(port)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {canShowChart ? (
        <>
          <div className="history-chart-shell">
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={chartRows} margin={{ top: 10, right: 12, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="serverHistoryFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f47b20" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#f47b20" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "var(--chart-axis)", fontSize: 12 }} />
                <YAxis yAxisId="power" tickLine={false} axisLine={false} tick={{ fill: "var(--chart-axis)", fontSize: 12 }} />
                <YAxis
                  yAxisId="temperature"
                  orientation="right"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "var(--amber-deep)", fontSize: 12 }}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--chart-tooltip-bg)",
                    border: "1px solid var(--chart-tooltip-border)",
                    borderRadius: 8,
                    color: "var(--chart-tooltip-ink)",
                  }}
                  formatter={(value, name) => name === "temperature" ? formatTemperatureTooltip(value) : formatPowerTooltip(value)}
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
            {status === "loading" ? (
              <div className="history-loading-overlay" role="status">
                <span />
                <strong>{t("readingHistory")}</strong>
              </div>
            ) : null}
          </div>
          <div className="history-stats">
            <span>{t("samples")} {rows.length}</span>
            <span>{t("avg")} {avgPower.toFixed(2)}W</span>
            <span>{t("max")} {maxPower.toFixed(2)}W</span>
            <span>{t("highestTemp")} {maxTemp == null ? "N/A" : `${maxTemp.toFixed(0)}C`}</span>
          </div>
        </>
      ) : (
        <div className={`history-empty ${status === "loading" ? "history-loading-skeleton" : ""}`}>
          {status === "loading" ? <i aria-hidden="true" /> : null}
          <strong>
            {status === "loading"
              ? t("readingHistory")
              : !canQuery
                ? t("invalidRange")
              : status === "empty"
                ? t("emptyHistory")
                : t("unavailableHistory")}
          </strong>
          <span>{t("sqliteHint")}</span>
        </div>
      )}
    </section>
  );
}

function formatDateTimeLocal(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDateTimeLocal(value: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

export function buildServerHistoryChartRows(rows: ServerHistoryRow[]) {
  const bucketMs = chooseHistoryBucketMs(rows);
  const buckets = new Map<number, Map<number, { power: number; temperature: number | null }>>();
  for (const row of rows) {
    const bucket = Math.floor(row.ts / bucketMs) * bucketMs;
    const timeline = buckets.get(bucket) ?? new Map<number, { power: number; temperature: number | null }>();
    const existing = timeline.get(row.ts) ?? { power: 0, temperature: null };
    const temperature = validTemperature(row.temperature_c);
    existing.power += row.power_w;
    existing.temperature = temperature == null
      ? existing.temperature
      : Math.max(existing.temperature ?? temperature, temperature);
    timeline.set(row.ts, existing);
    buckets.set(bucket, timeline);
  }

  const chartRows = Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([ts, timeline]) => {
      const values = Array.from(timeline.values());
      return {
        ts,
        time: new Date(ts).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }),
        power: values.reduce((sum, value) => sum + value.power, 0) / Math.max(values.length, 1),
        temperature: maxValidTemperature(values.map((value) => value.temperature)),
      };
    });
  return insertHistoryGaps(chartRows, bucketMs);
}

function insertHistoryGaps<T extends { ts: number; power: number | null; temperature: number | null }>(rows: T[], bucketMs: number) {
  if (rows.length < 2) return rows;
  const result: T[] = [];
  for (const row of rows) {
    const previous = result[result.length - 1];
    if (previous && row.ts - previous.ts > bucketMs * 2.5) {
      result.push({ ...previous, power: null, temperature: null });
      result.push({ ...row, power: null, temperature: null });
    }
    result.push(row);
  }
  return result;
}

function chooseHistoryBucketMs(rows: ServerHistoryRow[]) {
  if (rows.length < 2) return 60 * 1000;
  const span = rows[rows.length - 1].ts - rows[0].ts;
  if (span > 7 * 24 * 60 * 60 * 1000) return 60 * 60 * 1000;
  if (span > 24 * 60 * 60 * 1000) return 15 * 60 * 1000;
  if (span > 6 * 60 * 60 * 1000) return 5 * 60 * 1000;
  return 60 * 1000;
}

export function PowerChart({ history }: { history: PortHistory }) {
  const { t } = useI18n();
  const portKeys = ["A", "C1", "C2", "C3", "C4"];
  const portColors = ["#2b2926", "#f47b20", "#d9571c", "#917a54", "#6d9483"];
  const basePort = history.ports.reduce(
    (longest, port) => (port.samples.length > longest.samples.length ? port : longest),
    history.ports[0],
  );
  const rows = basePort?.samples.map((_, sampleIndex) => {
    const row: Record<string, number | string | null> & { time: string } = {
      time: formatSampleTime(
        basePort.samples[sampleIndex]?.ts,
        basePort.samples.length,
        sampleIndex,
        history.sample_period_ms,
      ),
    };

    for (const port of history.ports) {
      const sample = port.samples[sampleIndex];
      const key = port.port === 0 ? "A" : `C${port.port}`;
      row[key] = sample ? samplePower(sample) : 0;
      row[`${key}V`] = sample ? volts(sample.voltage) : null;
      row[`${key}A`] = sample ? amps(sample.current) : null;
    }
    row.temperature = maxValidTemperature(history.ports.map((port) => port.samples[sampleIndex]?.temperature_c));

    return row;
  }) ?? [];

  return (
    <section className="panel chart-panel">
      <div className="panel-header">
        <div>
          <p>{t("portTimeline")}</p>
          <h2>{t("livePowerAndTemp")}</h2>
          <span className="panel-note">{getHistoryCoverageLabel(history, t)}</span>
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
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "var(--chart-axis)", fontSize: 12 }} />
          <YAxis yAxisId="power" tickLine={false} axisLine={false} tick={{ fill: "var(--chart-axis)", fontSize: 12 }} />
          <YAxis
            yAxisId="temperature"
            orientation="right"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--amber-deep)", fontSize: 12 }}
          />
          <Tooltip
            contentStyle={{
              background: "var(--chart-tooltip-bg)",
              border: "1px solid var(--chart-tooltip-border)",
              borderRadius: 8,
              color: "var(--chart-tooltip-ink)",
            }}
            formatter={(value, name) => name === "temperature" ? formatTemperatureTooltip(value) : `${Number(value).toFixed(1)}W`}
          />
          {portKeys.map((key, index) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={portColors[index]}
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
      <div className="port-va-charts live-va-charts">
        <MultiMetricTrendChart
          colors={portColors}
          data={rows}
          keys={portKeys.map((key) => `${key}V`)}
          labels={portKeys}
          title={`${t("voltage")} (V)`}
          unit="V"
        />
        <MultiMetricTrendChart
          colors={portColors}
          data={rows}
          keys={portKeys.map((key) => `${key}A`)}
          labels={portKeys}
          title={`${t("current")} (A)`}
          unit="A"
        />
      </div>
    </section>
  );
}
