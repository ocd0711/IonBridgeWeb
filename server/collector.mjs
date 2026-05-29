import { requireDeviceKey } from "./db.mjs";
import { normalizeTarget } from "./target-security.mjs";

export function createCollector({ store, fetchMachineInfo, fetchJson, refreshConfig, broadcast }) {
  const timers = new Map();
  const collectingTargets = new Set();
  const stats = new Map();

  function startCollectors() {
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    for (const target of store.listTargets()) {
      runCollector(target.targetUrl);
      timers.set(target.targetUrl, setInterval(() => runCollector(target.targetUrl), target.refreshIntervalMs));
    }
  }

  function stopCollector(targetUrl) {
    const normalizedTarget = normalizeTarget(targetUrl);
    if (!timers.has(normalizedTarget)) return;
    clearInterval(timers.get(normalizedTarget));
    timers.delete(normalizedTarget);
  }

  function runCollector(targetUrl) {
    collectOnce(targetUrl).catch(async (error) => {
      store.markTargetStatusByTarget(targetUrl, "offline", error instanceof Error ? error.message : "collection failed");
      await refreshConfig();
    });
  }

  async function collectOnce(targetUrl) {
    const normalizedTarget = normalizeTarget(targetUrl);
    if (collectingTargets.has(normalizedTarget)) return;
    collectingTargets.add(normalizedTarget);
    const startedAt = Date.now();
    stats.set(normalizedTarget, {
      ...(stats.get(normalizedTarget) ?? {}),
      collecting: true,
      lastStartedAt: startedAt,
    });
    try {
      const machineInfo = await fetchMachineInfo(normalizedTarget);
      const deviceKey = requireDeviceKey(machineInfo);
      const [metrics, heap] = await Promise.all([
        fetchJson(new URL("/metrics.json", normalizedTarget).toString(), 8000),
        fetchJson(new URL("/heapz", normalizedTarget).toString(), 3500).catch(() => null),
      ]);
      const ts = Date.now();
      store.markTargetStatus(deviceKey, "online", null, { seenAt: ts });
      store.insertSamples(metrics.ports.map((port) => ({
        device_key: deviceKey,
        ts,
        target: normalizedTarget,
        port: port.id,
        voltage: port.voltage,
        current: port.current,
        temperature_c: validTemperature(port.die_temperature),
        power_w: (port.voltage * port.current) / 1_000_000,
        attached: port.attached ? 1 : 0,
        protocol: port.fc_protocol,
      })));
      store.pruneHistory(ts);
      const config = await refreshConfig();
      const snapshot = {
        type: "snapshot",
        deviceKey,
        targetUrl: normalizedTarget,
        ts,
        metrics,
        heap,
        machineInfo,
        config,
      };
      stats.set(normalizedTarget, {
        collecting: false,
        lastStartedAt: startedAt,
        lastFinishedAt: ts,
        lastSuccessAt: ts,
        lastErrorAt: null,
        lastError: null,
        lastDeviceKey: deviceKey,
        lastSampleCount: metrics.ports.length,
      });
      broadcast(snapshot);
    } catch (error) {
      const finishedAt = Date.now();
      const message = error instanceof Error ? error.message : "target unreachable";
      store.markTargetStatusByTarget(normalizedTarget, "offline", "target unreachable");
      stats.set(normalizedTarget, {
        ...(stats.get(normalizedTarget) ?? {}),
        collecting: false,
        lastStartedAt: startedAt,
        lastFinishedAt: finishedAt,
        lastErrorAt: finishedAt,
        lastError: message,
      });
      const config = await refreshConfig();
      broadcast({
        type: "status",
        targetUrl: normalizedTarget,
        status: "offline",
        error: "target unreachable",
        ts: Date.now(),
        config,
      });
    } finally {
      await refreshConfig();
      collectingTargets.delete(normalizedTarget);
    }
  }

  function targetStats(targetUrl) {
    return stats.get(targetUrl) ?? { collecting: false };
  }

  return { startCollectors, stopCollector, runCollector, targetStats };
}

function validTemperature(value) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}
