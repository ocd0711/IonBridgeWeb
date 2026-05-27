import { mockHeap, mockHistory, mockMachineInfo, mockMetrics } from "./mock";
import type { HeapMetrics, MachineInfo, Metrics, PortHistory } from "./types";

const DEFAULT_DEVICE_TARGET = "http://192.168.217.161";
const endpoint = (path: string, targetUrl: string) => {
  const normalizedTarget = normalizeDeviceTarget(targetUrl);
  if (normalizedTarget === DEFAULT_DEVICE_TARGET) {
    return `/device${path}`;
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
  };
};

export type ServerHistoryRow = {
  ts: number;
  target: string;
  port: number;
  voltage: number;
  current: number;
  temperature_c: number;
  power_w: number;
  attached: boolean;
  protocol: string;
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
    throw new Error("Password rejected");
  }
  return response.json() as Promise<ServerSession>;
}

export async function saveServerConfig(config: { targetUrl: string; refreshIntervalMs: number }) {
  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error("Failed to save server config");
  }
  return response.json() as Promise<ServerSession["config"]>;
}

export async function fetchServerHistory({
  targetUrl,
  hours,
  start,
  end,
  port,
}: {
  targetUrl: string;
  hours?: number;
  start?: number;
  end?: number;
  port: number | null;
}): Promise<ServerHistoryRow[]> {
  const params = new URLSearchParams({
    target: normalizeDeviceTarget(targetUrl),
  });
  if (hours != null) params.set("hours", String(hours));
  if (start != null) params.set("start", String(start));
  if (end != null) params.set("end", String(end));
  if (port != null) params.set("port", String(port));

  const response = await fetch(`/api/history?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Server history unavailable");
  const payload = await response.json() as { rows?: ServerHistoryRow[] };
  return payload.rows ?? [];
}

async function getJson<T>(path: string, targetUrl: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const response = await fetchWithTimeout(endpoint(path, targetUrl), timeoutMs);
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function getMachineInfo(targetUrl: string): Promise<MachineInfo> {
  const response = await fetchWithTimeout(endpoint("/", targetUrl), MACHINE_INFO_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`/ returned ${response.status}`);
  }

  const html = await response.text();
  const match = html.match(/window\.__INFOZ=(\{.*?\});/);
  if (!match) {
    throw new Error("window.__INFOZ not found");
  }

  return JSON.parse(match[1]) as MachineInfo;
}

async function getMachineInfoWithRetry(targetUrl: string, attempts = 3): Promise<MachineInfo> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await getMachineInfo(targetUrl);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getJsonWithRetry<T>(path: string, targetUrl: string, timeoutMs: number, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await getJson<T>(path, targetUrl, timeoutMs);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchDashboardData(targetUrl = DEFAULT_DEVICE_TARGET): Promise<{
  metrics: Metrics;
  history: PortHistory;
  heap: HeapMetrics;
  machineInfo: MachineInfo;
  source: "device" | "mock";
}> {
  const normalizedTarget = normalizeDeviceTarget(targetUrl);
  try {
    const metrics = await getJsonWithRetry<Metrics>("/metrics.json", normalizedTarget, METRICS_TIMEOUT_MS);
    const [history, heap, machineInfo] = await Promise.all([
      getJson<PortHistory>(`/porthistoryz?limit=${HISTORY_LIMIT}`, normalizedTarget).catch(() => liveOnlyHistory(metrics)),
      getJson<HeapMetrics>("/heapz", normalizedTarget).catch(() => mockHeap),
      getMachineInfoWithRetry(normalizedTarget)
        .then((info) => {
          writeCachedMachineInfo(normalizedTarget, info);
          return info;
        })
        .catch(() => readCachedMachineInfo(normalizedTarget) ?? inferMachineInfo(metrics)),
    ]);

    return { metrics, history: mergeHistory(history, metrics, normalizedTarget), heap, machineInfo, source: "device" };
  } catch {
    return {
      metrics: mockMetrics,
      history: mockHistory,
      heap: mockHeap,
      machineInfo: mockMachineInfo,
      source: "mock",
    };
  }
}

function liveOnlyHistory(metrics: Metrics): PortHistory {
  return {
    sample_period_ms: 10000,
    ports: metrics.ports.map((port) => ({
      port: port.id,
      samples: [{ voltage: port.voltage, current: port.current, temperature_c: port.die_temperature, ts: Date.now() }],
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

function mergeHistory(seed: PortHistory, metrics: Metrics, targetUrl: string): PortHistory {
  const now = Date.now();
  const period = seed.sample_period_ms > 0 ? seed.sample_period_ms : 10000;
  const stored = readStoredHistory(targetUrl);
  const byPort = new Map<number, Array<{ voltage: number; current: number; temperature_c?: number; ts: number }>>();

  for (const port of stored.ports) {
    byPort.set(port.port, port.samples.filter(hasTs));
  }

  for (const port of seed.ports) {
    const start = now - Math.max(port.samples.length - 1, 0) * period;
    const timeline = port.samples.map((sample, index) => ({
      voltage: sample.voltage,
      current: sample.current,
      temperature_c: sample.temperature_c,
      ts: sample.ts ?? start + index * period,
    }));
    byPort.set(port.port, mergeSamples(byPort.get(port.port) ?? [], timeline, now));
  }

  for (const port of metrics.ports) {
    const current = {
      voltage: port.voltage,
      current: port.current,
      temperature_c: port.die_temperature,
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

function mergeSamples(
  existing: Array<{ voltage: number; current: number; temperature_c?: number; ts: number }>,
  incoming: Array<{ voltage: number; current: number; temperature_c?: number; ts: number }>,
  now: number,
) {
  const cutoff = now - HISTORY_WINDOW_MS;
  const merged = [...existing, ...incoming]
    .filter((sample) => sample.ts >= cutoff && sample.ts <= now + 1000)
    .sort((a, b) => a.ts - b.ts);
  const deduped: Array<{ voltage: number; current: number; temperature_c?: number; ts: number }> = [];
  for (const sample of merged) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.ts - sample.ts) < 1000) {
      deduped[deduped.length - 1] = sample;
    } else {
      deduped.push(sample);
    }
  }
  return deduped;
}

function hasTs(
  sample: { voltage: number; current: number; temperature_c?: number; ts?: number },
): sample is { voltage: number; current: number; temperature_c?: number; ts: number } {
  return Number.isFinite(sample.ts);
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
