import { mockHeap, mockHistory, mockMachineInfo, mockMetrics } from "./mock";
import type { HeapMetrics, MachineInfo, Metrics, PortHistory, PortMetrics } from "./types";

const DEFAULT_DEVICE_TARGET = "http://192.168.217.161";
const endpoint = (path: string, targetUrl: string, deviceKey?: string | null) => {
  const normalizedTarget = normalizeDeviceTarget(targetUrl);
  if (normalizedTarget === DEFAULT_DEVICE_TARGET) {
    return `/device${path}`;
  }
  if (deviceKey) {
    return `/device-proxy${path}?device=${encodeURIComponent(deviceKey)}`;
  }
  return `/device-proxy${path}?target=${encodeURIComponent(normalizedTarget)}`;
};
const HISTORY_LIMIT = 360;
const HISTORY_WINDOW_MS = 60 * 60 * 1000;
const HISTORY_STORAGE_PREFIX = "ionbridge:port-history:v1:";
const MACHINE_INFO_STORAGE_PREFIX = "ionbridge:machine-info:v1:";
const REQUEST_TIMEOUT_MS = 3500;
const METRICS_TIMEOUT_MS = 8000;
const MACHINE_INFO_TIMEOUT_MS = 8000;
const TEMPERATURE_BACKFILL_MAX_AGE_MS = 2 * 60 * 1000;
const mqttActiveUntilByDevice = new Map<string, number>();

export class AuthRequiredError extends Error {
  constructor() {
    super("authentication required");
    this.name = "AuthRequiredError";
  }
}

export function isAuthRequiredError(error: unknown) {
  return error instanceof AuthRequiredError;
}

function throwIfUnauthorized(response: Response) {
  if (response.status === 401) throw new AuthRequiredError();
}

export function normalizeDeviceTarget(targetUrl: string) {
  const trimmed = targetUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_DEVICE_TARGET;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function defaultDeviceTarget() {
  return DEFAULT_DEVICE_TARGET;
}

export type ServerSession = {
  passwordEnabled: boolean;
  authenticated: boolean;
  config: {
    targetUrl: string;
    refreshIntervalMs: number;
    showAppearanceSwitcher?: boolean;
    mqtt?: MqttConfig;
    targets: SavedTarget[];
  };
};

export type MqttConfig = {
  enabled: boolean;
  brokerUrl: string;
  username: string;
  configured: boolean;
  hasPassword: boolean;
};

export type MqttStatus = {
  enabled: boolean;
  configured: boolean;
  brokerUrl: string;
  connected: boolean;
  lastError: string | null;
  lastMessageAt: number | null;
};

export type SavedTarget = {
  targetUrl: string;
  refreshIntervalMs: number;
  deviceKey: string | null;
  note: string;
  lastStatus: "online" | "offline" | "unknown";
  lastError: string | null;
  lastSeen: number | null;
  lastSampleAt: number | null;
};

export type ServerHistoryRow = {
  ts: number;
  target: string;
  port: number;
  active?: boolean;
  attached: boolean;
  voltage: number;
  current: number;
  state?: string;
  temperature_c: number | null;
  power_w: number;
  protocol: string;
};

export type LiveDashboardSnapshot = {
  type: "snapshot";
  source?: "http" | "mqtt";
  deviceKey: string;
  targetUrl: string;
  ts: number;
  metrics: Metrics;
  heap: HeapMetrics | null;
  machineInfo: MachineInfo;
  config?: ServerSession["config"];
};

export type LiveStatusEvent = {
  type: "status";
  targetUrl: string;
  status: "offline" | "online" | "unknown";
  error?: string;
  ts: number;
  config?: ServerSession["config"];
};

export async function getServerSession(): Promise<ServerSession | null> {
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (!response.ok) return null;
    return response.json() as Promise<ServerSession>;
  } catch {
    return null;
  }
}

export async function login(password: string): Promise<ServerSession> {
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new Error("密码不正确");
  }
  return response.json() as Promise<ServerSession>;
}

export async function saveServerConfig(config: { targetUrl: string; refreshIntervalMs: number; note?: string }) {
  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error(await responseErrorMessage(response, "连接失败或设备未提供 PSN，未保存"));
  }
  return response.json() as Promise<ServerSession["config"]>;
}

export async function saveMqttConfig(config: { enabled: boolean; brokerUrl: string; username: string; password?: string; deviceKey?: string | null }) {
  const response = await fetch("/api/mqtt", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error(await responseErrorMessage(response, "MQTT 配置保存失败"));
  }
  return response.json() as Promise<{ config: ServerSession["config"]; mqtt: { config: MqttConfig; status: MqttStatus } }>;
}

export async function fetchMqttStatus() {
  const response = await fetch("/api/mqtt", { cache: "no-store" });
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error(await responseErrorMessage(response, "MQTT 状态读取失败"));
  }
  return response.json() as Promise<{ config: MqttConfig; status: MqttStatus }>;
}

export async function setMqttTelemetryStream(deviceKey: string, enabled: boolean) {
  const response = await fetch("/api/mqtt/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceKey, enabled }),
  });
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error(await responseErrorMessage(response, "MQTT 遥测流控制失败"));
  }
}

export async function setMqttPortPower(deviceKey: string, port: number, enabled: boolean) {
  const response = await fetch("/api/mqtt/ports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceKey, port, enabled }),
  });
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error(await responseErrorMessage(response, "MQTT 端口控制失败"));
  }
}

export type MqttControlAction =
  | "devicePower"
  | "rebootDevice"
  | "telemetryStream"
  | "portPower"
  | "chargingStrategy"
  | "temperatureMode"
  | "temporaryAllocation"
  | "portCompatibility"
  | "portConfig"
  | "portType"
  | "customPdoVoltage"
  | "cableCompensation"
  | "displayIntensity"
  | "displayMode"
  | "displaySetup";

export type MqttControlState = {
  chargingStrategy?: number;
  compatibility?: {
    enableTfcp: boolean;
    enableFcp: boolean;
    enableUfcs: boolean;
    enableHvScp: boolean;
    enableLvScp: boolean;
  };
  portConfigs?: MqttPortConfig[];
  displayIntensity?: number;
  displayMode?: number;
  displayRotation?: number;
  idleAnimation?: number;
  cableCompensation?: Record<string, {
    enable: boolean;
    resistance: number;
    voltageOffset: number;
  }>;
};

export type MqttPowerFeatures = {
  enableTfcp: boolean;
  enablePe: boolean;
  enableQc2p0: boolean;
  enableQc3p0: boolean;
  enableQc3plus: boolean;
  enableAfc: boolean;
  enableFcp: boolean;
  enableHvScp: boolean;
  enableLvScp: boolean;
  enableSfcp: boolean;
  enableApple: boolean;
  enableSamsung: boolean;
  enableUfcs: boolean;
  enablePd: boolean;
  enablePdCompatMode: boolean;
  limitedCurrentMode: boolean;
  enablePdLvpps: boolean;
  enablePdEpr: boolean;
  enablePdRpi: boolean;
  enablePdHvpps: boolean;
  enablePdHardResetOnRefusal: boolean;
  enablePdSprAvs: boolean;
};

export type MqttPortConfig = {
  version: number;
  features: MqttPowerFeatures;
};

export type MqttControlStateResult = {
  state: MqttControlState;
  errors: Record<string, string>;
};

export async function sendMqttControl(deviceKey: string, action: MqttControlAction, params: Record<string, unknown> = {}) {
  const response = await fetch("/api/mqtt/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceKey, action, params }),
  });
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error(await responseErrorMessage(response, "MQTT 控制命令发送失败"));
  }
  return response.json() as Promise<{ ok: true }>;
}

export async function fetchMqttControlState(deviceKey: string, ports: number[]) {
  const response = await fetch("/api/mqtt/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceKey, ports }),
  });
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error(await responseErrorMessage(response, "MQTT 控制状态读取失败"));
  }
  return response.json() as Promise<{ ok: true } & MqttControlStateResult>;
}

export async function deleteSavedTarget(targetUrl: string) {
  const params = new URLSearchParams({ target: normalizeDeviceTarget(targetUrl) });
  const response = await fetch(`/api/targets?${params.toString()}`, { method: "DELETE" });
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error("移除设备失败");
  }
  return response.json() as Promise<ServerSession["config"]>;
}

export async function updateSavedTargetNote(target: { targetUrl: string; deviceKey: string | null; note: string }) {
  const response = await fetch("/api/targets", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetUrl: normalizeDeviceTarget(target.targetUrl),
      deviceKey: target.deviceKey,
      note: target.note,
    }),
  });
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error("更新备注失败");
  }
  return response.json() as Promise<ServerSession["config"]>;
}

async function responseErrorMessage(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setActiveServerTarget(targetUrl: string) {
  const response = await fetch("/api/targets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetUrl: normalizeDeviceTarget(targetUrl) }),
  });
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error("切换设备失败");
  }
  return response.json() as Promise<ServerSession["config"]>;
}

export async function fetchServerHistory({
  targetUrl,
  deviceKey,
  hours,
  start,
  end,
  port,
}: {
  targetUrl: string;
  deviceKey?: string | null;
  hours?: number;
  start?: number;
  end?: number;
  port: number | null;
}): Promise<ServerHistoryRow[]> {
  const params = new URLSearchParams();
  if (deviceKey) {
    params.set("device", deviceKey);
  } else {
    params.set("target", normalizeDeviceTarget(targetUrl));
  }
  if (hours != null) params.set("hours", String(hours));
  if (start != null) params.set("start", String(start));
  if (end != null) params.set("end", String(end));
  if (port != null) params.set("port", String(port));

  const response = await fetch(`/api/history?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error("服务端历史不可用");
  }
  const payload = await response.json() as { rows?: ServerHistoryRow[] };
  return payload.rows ?? [];
}

async function fetchRecentServerHistory(targetUrl: string, deviceKey?: string | null): Promise<ServerHistoryRow[]> {
  try {
    return fetchServerHistory({ targetUrl, deviceKey, hours: 720, port: null });
  } catch (error) {
    if (isAuthRequiredError(error)) throw error;
    return [];
  }
}

async function fetchRollingServerHistory(targetUrl: string, deviceKey?: string | null): Promise<ServerHistoryRow[]> {
  try {
    return fetchServerHistory({ targetUrl, deviceKey, hours: 1, port: null });
  } catch (error) {
    if (isAuthRequiredError(error)) throw error;
    return [];
  }
}

async function getJson<T>(path: string, targetUrl: string, timeoutMs = REQUEST_TIMEOUT_MS, deviceKey?: string | null): Promise<T> {
  const response = await fetchWithTimeout(endpoint(path, targetUrl, deviceKey), timeoutMs);
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function getMachineInfo(targetUrl: string, deviceKey?: string | null): Promise<MachineInfo> {
  const response = await fetchWithTimeout(endpoint("/", targetUrl, deviceKey), MACHINE_INFO_TIMEOUT_MS);
  if (!response.ok) {
    throwIfUnauthorized(response);
    throw new Error(`/ returned ${response.status}`);
  }

  const html = await response.text();
  const match = html.match(/window\.__INFOZ=(\{.*?\});/);
  if (!match) {
    throw new Error("window.__INFOZ not found");
  }

  return JSON.parse(match[1]) as MachineInfo;
}

async function getMachineInfoWithRetry(targetUrl: string, deviceKey?: string | null, attempts = 3): Promise<MachineInfo> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await getMachineInfo(targetUrl, deviceKey);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getJsonWithRetry<T>(path: string, targetUrl: string, timeoutMs: number, deviceKey?: string | null, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await getJson<T>(path, targetUrl, timeoutMs, deviceKey);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function fetchDashboardData(targetUrl = DEFAULT_DEVICE_TARGET, deviceKey?: string | null): Promise<{
  metrics: Metrics;
  history: PortHistory;
  heap: HeapMetrics;
  machineInfo: MachineInfo;
  source: "device" | "offline" | "mock";
}> {
  const normalizedTarget = normalizeDeviceTarget(targetUrl);
  try {
    const metrics = await getJsonWithRetry<Metrics>("/metrics.json", normalizedTarget, METRICS_TIMEOUT_MS, deviceKey);
    const [history, serverRows, heap, machineInfo] = await Promise.all([
      getJson<PortHistory>(`/porthistoryz?limit=${HISTORY_LIMIT}`, normalizedTarget, REQUEST_TIMEOUT_MS, deviceKey).catch(() => liveOnlyHistory(metrics)),
      fetchRollingServerHistory(normalizedTarget, deviceKey),
      getJson<HeapMetrics>("/heapz", normalizedTarget, REQUEST_TIMEOUT_MS, deviceKey).catch(() => mockHeap),
      getMachineInfoWithRetry(normalizedTarget, deviceKey)
        .then((info) => {
          writeCachedMachineInfo(normalizedTarget, info);
          return info;
        })
        .catch(() => readCachedMachineInfo(normalizedTarget) ?? inferMachineInfo(metrics)),
    ]);

    const mergedDeviceHistory = mergeHistory(history, metrics, normalizedTarget);
    const mergedHistory = serverRows.length > 0
      ? mergeHistory(historyFromServerRows(serverRows), metrics, normalizedTarget)
      : mergedDeviceHistory;
    return { metrics: mergePortTemperatures(metrics, mergedHistory), history: mergedHistory, heap, machineInfo, source: "device" };
  } catch (error) {
    if (isAuthRequiredError(error)) throw error;
    return fetchOfflineDashboardData(normalizedTarget, deviceKey);
  }
}

export async function fetchOfflineDashboardData(targetUrl = DEFAULT_DEVICE_TARGET, deviceKey?: string | null): Promise<{
  metrics: Metrics;
  history: PortHistory;
  heap: HeapMetrics;
  machineInfo: MachineInfo;
  source: "offline" | "mock";
}> {
  const normalizedTarget = normalizeDeviceTarget(targetUrl);
  const rows = await fetchRecentServerHistory(normalizedTarget, deviceKey);
  if (rows.length > 0) {
    const metrics = offlineMetricsFromHistory(rows);
    const history = historyFromServerRows(rows);
    return {
      metrics,
      history,
      heap: mockHeap,
      machineInfo: readCachedMachineInfo(normalizedTarget) ?? inferMachineInfo(metrics),
      source: "offline",
    };
  }
  return {
    metrics: mockMetrics,
    history: mockHistory,
    heap: mockHeap,
    machineInfo: mockMachineInfo,
    source: "mock",
  };
}

export function liveStreamUrl(targetUrl: string, deviceKey?: string | null) {
  const params = new URLSearchParams();
  if (deviceKey) {
    params.set("device", deviceKey);
  } else {
    params.set("target", normalizeDeviceTarget(targetUrl));
  }
  return `/api/live?${params.toString()}`;
}

export function mergeLiveDashboardData(
  current: Awaited<ReturnType<typeof fetchDashboardData>> | null,
  snapshot: LiveDashboardSnapshot,
): Awaited<ReturnType<typeof fetchDashboardData>> {
  const mqttActive = isMqttActiveForSnapshot(snapshot);
  const keepMqttPorts = snapshot.source === "http" && mqttActive && current;
  const portMetrics = keepMqttPorts
    ? { ...current.metrics, ports: mergeMissingPortMetrics(current.metrics.ports, snapshot.metrics.ports) }
    : snapshot.metrics;
  const machineInfo = mergeMachineInfo(current?.machineInfo, snapshot.machineInfo);
  writeCachedMachineInfo(snapshot.targetUrl, machineInfo);
  const baseHistory = current?.history ?? liveOnlyHistory(portMetrics);
  return {
    metrics: mergeLiveMetrics(current?.metrics, snapshot.metrics, portMetrics.ports),
    history: keepMqttPorts ? baseHistory : mergeHistory(baseHistory, portMetrics, snapshot.targetUrl, snapshot.ts),
    heap: snapshot.heap ?? current?.heap ?? mockHeap,
    machineInfo,
    source: "device",
  };
}

function isMqttActiveForSnapshot(snapshot: LiveDashboardSnapshot) {
  const activeWindow = mqttActiveWindowMs(snapshot);
  if (snapshot.source === "mqtt" && snapshot.metrics.ports.length > 0) {
    mqttActiveUntilByDevice.set(snapshot.deviceKey, snapshot.ts + activeWindow);
    return true;
  }
  return Date.now() < (mqttActiveUntilByDevice.get(snapshot.deviceKey) ?? 0);
}

function mqttActiveWindowMs(snapshot: LiveDashboardSnapshot) {
  const target = snapshot.config?.targets.find((item) => item.deviceKey === snapshot.deviceKey);
  const interval = target?.refreshIntervalMs ?? snapshot.config?.refreshIntervalMs ?? 0;
  return Math.max(5000, (interval || 30000) * 2);
}

function mergeMissingPortMetrics(primary: Metrics["ports"], fallback: Metrics["ports"]): Metrics["ports"] {
  const fallbackByPort = new Map(fallback.map((port) => [port.id, port]));
  return primary.map((port) => {
    const supplement = fallbackByPort.get(port.id);
    if (!supplement) return port;
    return {
      ...supplement,
      ...port,
      die_temperature: validTemperature(port.die_temperature) ?? validTemperature(supplement.die_temperature) ?? undefined,
      pd_status: port.pd_status ?? supplement.pd_status,
      power_budget: port.power_budget || supplement.power_budget,
      charging_duration_seconds: port.charging_duration_seconds || supplement.charging_duration_seconds,
      vin_value: port.vin_value || supplement.vin_value,
    };
  });
}

function mergeLiveMetrics(current: Metrics | undefined, snapshot: Metrics, ports: Metrics["ports"]): Metrics {
  if (!current) return snapshot;
  return {
    ports: ports.length > 0 ? ports : current.ports,
    system: {
      ...current.system,
      ...nonEmptyObject(snapshot.system),
    },
    tasks: snapshot.tasks.length > 0 ? snapshot.tasks : current.tasks,
    wifi: {
      ...current.wifi,
      ...nonEmptyObject(snapshot.wifi),
    },
  };
}

function mergeMachineInfo(current: MachineInfo | undefined, snapshot: MachineInfo): MachineInfo {
  if (!current) return snapshot;
  return {
    ...current,
    ...nonEmptyObject(snapshot),
  };
}

function nonEmptyObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry == null) return false;
      if (typeof entry === "string") return entry.trim() !== "" && entry !== "unknown";
      if (typeof entry === "number") return Number.isFinite(entry) && entry !== 0;
      return true;
    }),
  ) as Partial<T>;
}

function offlineMetricsFromHistory(rows: ServerHistoryRow[]): Metrics {
  const latestTs = Math.max(...rows.map((row) => row.ts));
  const latestRows = rows.filter((row) => row.ts === latestTs);
  const ports: PortMetrics[] = latestRows.map((row) => ({
    id: row.port,
    active: row.active ?? row.attached,
    state: row.state || (row.attached ? "ATTACHED" : "ACTIVE"),
    port_type: row.port === 0 ? "A" as const : "C" as const,
    attached: row.attached,
    charging_duration_seconds: 0,
    fc_protocol: Number.parseFloat(row.protocol) || 0,
    current: row.current,
    voltage: row.voltage,
    die_temperature: validTemperature(row.temperature_c) ?? undefined,
    vin_value: 0,
    session_id: 0,
    session_charge: 0,
    power_budget: 0,
    pd_status: null,
  })).sort((a, b) => a.id - b.id);

  return {
    ...mockMetrics,
    ports,
    wifi: { ...mockMetrics.wifi, rssi: 0 },
    system: { ...mockMetrics.system, boot_time_seconds: 0 },
    tasks: [],
  };
}

function historyFromServerRows(rows: ServerHistoryRow[]): PortHistory {
  const byPort = new Map<number, Array<{ active?: boolean; attached?: boolean; voltage: number; current: number; state?: string; temperature_c?: number; ts: number }>>();
  for (const row of rows) {
    const samples = byPort.get(row.port) ?? [];
    const temperature = validTemperature(row.temperature_c);
    samples.push({
      active: row.active,
      attached: row.attached,
      voltage: row.voltage,
      current: row.current,
      state: row.state,
      ...(temperature == null ? {} : { temperature_c: temperature }),
      ts: row.ts,
    });
    byPort.set(row.port, samples);
  }
  return {
    sample_period_ms: 30000,
    ports: Array.from(byPort.entries()).map(([port, samples]) => ({
      port,
      samples: samples.sort((a, b) => a.ts - b.ts),
    })),
  };
}

function liveOnlyHistory(metrics: Metrics, ts = Date.now()): PortHistory {
  return {
    sample_period_ms: 10000,
    ports: metrics.ports.map((port) => ({
      port: port.id,
      samples: [{
        voltage: port.voltage,
        current: port.current,
        active: port.active,
        attached: port.attached,
        state: port.state,
        ...(validTemperature(port.die_temperature) == null ? {} : { temperature_c: validTemperature(port.die_temperature) as number }),
        ts,
      }],
    })),
  };
}

function inferMachineInfo(metrics: Metrics): MachineInfo {
  return {
    psn: "unknown",
    ble_mac: "unknown",
    wifi_mac: "unknown",
    hw_rev: "unknown",
    device_model: "unknown",
    device_name: `IonBridge-${metrics.system.app_version}`,
    product_family: "Unknown",
    product_color: "unknown",
    esp32_version: metrics.system.app_version,
    mcu_version: "unknown",
    fpga_version: "unknown",
    zrlib_version: "unknown",
    country_code: "unknown",
    mdns_hostname: "ionbridge",
  };
}

function machineInfoStorageKey(targetUrl: string) {
  return `${MACHINE_INFO_STORAGE_PREFIX}${encodeURIComponent(normalizeDeviceTarget(targetUrl))}`;
}

function readCachedMachineInfo(targetUrl: string): MachineInfo | null {
  try {
    const raw = localStorage.getItem(machineInfoStorageKey(targetUrl));
    return raw ? JSON.parse(raw) as MachineInfo : null;
  } catch {
    return null;
  }
}

function writeCachedMachineInfo(targetUrl: string, machineInfo: MachineInfo) {
  if (!machineInfo.psn || machineInfo.psn === "unknown") return;
  try {
    localStorage.setItem(machineInfoStorageKey(targetUrl), JSON.stringify(machineInfo));
  } catch {
    // Non-critical. The current fetch still carries the fresh machine info.
  }
}

function mergeHistory(seed: PortHistory, metrics: Metrics, targetUrl: string, now = Date.now()): PortHistory {
  const period = seed.sample_period_ms > 0 ? seed.sample_period_ms : 10000;
  const stored = readStoredHistory(targetUrl);
  const byPort = new Map<number, Array<{ active?: boolean; attached?: boolean; voltage: number; current: number; state?: string; temperature_c?: number; ts: number }>>();

  for (const port of stored.ports) {
    byPort.set(port.port, port.samples.filter(hasTs));
  }

  for (const port of seed.ports) {
    const start = now - Math.max(port.samples.length - 1, 0) * period;
    const timeline = port.samples.map((sample, index) => ({
      voltage: sample.voltage,
      current: sample.current,
      active: sample.active,
      attached: sample.attached,
      state: sample.state,
      temperature_c: sample.temperature_c,
      ts: sample.ts ?? start + index * period,
    }));
    byPort.set(port.port, mergeSamples(byPort.get(port.port) ?? [], timeline, now));
  }

  for (const port of metrics.ports) {
    const current = {
      voltage: port.voltage,
      current: port.current,
      active: port.active,
      attached: port.attached,
      state: port.state,
      temperature_c: validTemperature(port.die_temperature) ?? undefined,
      ts: now,
    };
    byPort.set(port.id, mergeSamples(byPort.get(port.id) ?? [], [current], now));
  }

  const merged: PortHistory = {
    sample_period_ms: period,
    ports: Array.from(byPort.entries())
      .sort(([a], [b]) => a - b)
      .map(([port, samples]) => ({ port, samples })),
  };
  writeStoredHistory(targetUrl, merged);
  return merged;
}

function mergePortTemperatures(metrics: Metrics, history: PortHistory, now = Date.now()): Metrics {
  const latestTemperatures = new Map<number, { temperature: number; ts: number }>();
  for (const port of history.ports) {
    for (const sample of port.samples) {
      const temperature = validTemperature(sample.temperature_c);
      const ts = sample.ts;
      if (temperature == null || typeof ts !== "number" || !Number.isFinite(ts)) continue;
      const current = latestTemperatures.get(port.port);
      if (!current || ts > current.ts) {
        latestTemperatures.set(port.port, { temperature, ts });
      }
    }
  }
  return {
    ...metrics,
    ports: metrics.ports.map((port) => {
      if (validTemperature(port.die_temperature) != null) return port;
      const latest = latestTemperatures.get(port.id);
      if (!latest || now - latest.ts > TEMPERATURE_BACKFILL_MAX_AGE_MS) return port;
      return { ...port, die_temperature: latest.temperature };
    }),
  };
}

function mergeSamples(
  existing: Array<{ active?: boolean; attached?: boolean; voltage: number; current: number; state?: string; temperature_c?: number; ts: number }>,
  incoming: Array<{ active?: boolean; attached?: boolean; voltage: number; current: number; state?: string; temperature_c?: number; ts: number }>,
  now: number,
) {
  const cutoff = now - HISTORY_WINDOW_MS;
  const merged = [...existing, ...incoming]
    .filter((sample) => sample.ts >= cutoff && sample.ts <= now + 1000)
    .sort((a, b) => a.ts - b.ts);
  const deduped: Array<{ active?: boolean; attached?: boolean; voltage: number; current: number; state?: string; temperature_c?: number; ts: number }> = [];
  for (const sample of merged) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.ts - sample.ts) < 1000) {
      deduped[deduped.length - 1] = {
        ...last,
        ...sample,
        active: sample.active ?? last.active,
        attached: sample.attached ?? last.attached,
        state: sample.state ?? last.state,
        temperature_c: sample.temperature_c ?? last.temperature_c,
      };
    } else {
      deduped.push(sample);
    }
  }
  return deduped;
}

function hasTs(
  sample: { active?: boolean; attached?: boolean; voltage: number; current: number; state?: string; temperature_c?: number; ts?: number },
): sample is { active?: boolean; attached?: boolean; voltage: number; current: number; state?: string; temperature_c?: number; ts: number } {
  return Number.isFinite(sample.ts);
}

function validTemperature(value: number | null | undefined) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}

function historyStorageKey(targetUrl: string) {
  return `${HISTORY_STORAGE_PREFIX}${encodeURIComponent(normalizeDeviceTarget(targetUrl))}`;
}

function readStoredHistory(targetUrl: string): PortHistory {
  try {
    const raw = localStorage.getItem(historyStorageKey(targetUrl));
    if (!raw) return { sample_period_ms: 10000, ports: [] };
    return JSON.parse(raw) as PortHistory;
  } catch {
    return { sample_period_ms: 10000, ports: [] };
  }
}

function writeStoredHistory(targetUrl: string, history: PortHistory) {
  try {
    localStorage.setItem(historyStorageKey(targetUrl), JSON.stringify(history));
  } catch {
    // Non-critical. Charts still work with in-memory fetch results.
  }
}
