import { clampInterval, requireDeviceKey } from "./db.mjs";
import { normalizeTarget } from "./target-security.mjs";

export function createRoutes({
  store,
  collector,
  live,
  getConfig,
  refreshConfig,
  fetchMachineInfo,
  fetchTarget,
  defaultIntervalMs,
  retentionDays,
  readJson,
  sendJson,
}) {
  async function handleHistory(url, res) {
    const config = getConfig();
    const target = normalizeTarget(url.searchParams.get("target") ?? config.targetUrl);
    const hours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("hours") ?? 24)));
    const startParam = parseOptionalTimestamp(url.searchParams.get("start"));
    const endParam = parseOptionalTimestamp(url.searchParams.get("end"));
    const portFilter = url.searchParams.get("port");
    const now = Date.now();
    const start = startParam ?? now - hours * 60 * 60 * 1000;
    const end = endParam ?? now;
    const historyKey = store.resolveHistoryKey(target);
    const rows = store.queryHistory({ ...historyKey, start, end, portFilter });
    sendJson(res, { target, deviceKey: historyKey.deviceKey, hours, start, end, rows });
  }

  function statusPayload() {
    const sampleCounts = store.sampleCounts();
    return {
      ok: true,
      retentionDays,
      liveClients: live.clientCount(),
      collectors: store.listTargets().map((target) => {
        const sample = sampleCounts.get(target.deviceKey) ?? {};
        return {
          deviceKey: target.deviceKey,
          targetUrl: target.targetUrl,
          refreshIntervalMs: target.refreshIntervalMs,
          status: target.lastStatus,
          lastError: target.lastError,
          lastSeen: target.lastSeen,
          lastSampleAt: sample.lastSampleAt ?? target.lastSampleAt,
          sampleCount: sample.count ?? 0,
          collector: collector.targetStats(target.targetUrl),
        };
      }),
    };
  }

  async function handleConfig(req, res) {
    const config = getConfig();
    const body = await readJson(req);
    const targetUrl = normalizeTarget(body.targetUrl ?? config.targetUrl);
    if (!targetUrl) return sendJson(res, { error: "targetUrl is required" }, 400);
    const refreshIntervalMs = clampInterval(Number(body.refreshIntervalMs ?? config.refreshIntervalMs), defaultIntervalMs);
    let machineInfo;
    let deviceKey;
    try {
      machineInfo = await fetchMachineInfo(targetUrl);
      deviceKey = requireDeviceKey(machineInfo);
    } catch (error) {
      return sendJson(res, {
        error: error instanceof Error && error.message.includes("PSN")
          ? error.message
          : "target connection failed; device was not saved",
      }, 422);
    }
    store.upsertVerifiedTarget({ deviceKey, targetUrl, refreshIntervalMs, note: body.note, active: true });
    const nextConfig = await refreshConfig();
    collector.startCollectors();
    sendJson(res, nextConfig);
  }

  async function handleSetActiveTarget(req, res) {
    const body = await readJson(req);
    const targetUrl = normalizeTarget(body.targetUrl);
    if (!targetUrl) return sendJson(res, { error: "targetUrl is required" }, 400);
    const deviceKey = store.savedTargetDeviceKey(targetUrl);
    if (!deviceKey) return sendJson(res, { error: "target is not saved" }, 404);
    store.setSetting("active_device_key", deviceKey);
    sendJson(res, await refreshConfig());
  }

  async function handleUpdateTarget(req, res) {
    const body = await readJson(req);
    const changes = store.updateTargetNote({
      deviceKey: body.deviceKey,
      targetUrl: body.targetUrl,
      note: body.note,
    });
    if (changes === 0) return sendJson(res, { error: "target is not saved" }, 404);
    sendJson(res, await refreshConfig());
  }

  async function handleDeleteTarget(url, res) {
    const target = url.searchParams.get("target");
    if (!target) return sendJson(res, { error: "missing target" }, 400);
    const targetUrl = normalizeTarget(target);
    collector.stopCollector(targetUrl);
    store.deleteTargetAndSamples(targetUrl);
    await refreshConfig();
    collector.startCollectors();
    sendJson(res, getConfig());
  }

  async function proxyCurrentTarget(req, res, url) {
    const config = getConfig();
    const path = url.pathname.replace(/^\/device/, "") || "/";
    if (!config.targetUrl) return sendJson(res, { error: "target not configured" }, 404);
    const targetUrl = new URL(`${path}${url.search}`, config.targetUrl);
    return proxyFetch(req, res, targetUrl);
  }

  async function proxyRequest(req, res, url) {
    const target = resolveSavedProxyTarget(url);
    if (!target) return sendJson(res, { error: "target is not saved" }, 403);
    url.searchParams.delete("target");
    url.searchParams.delete("device");
    url.searchParams.delete("psn");
    const path = url.pathname.replace(/^\/device-proxy/, "") || "/";
    const targetUrl = new URL(`${path}${url.search}`, target);
    return proxyFetch(req, res, targetUrl);
  }

  function parseOptionalTimestamp(value) {
    if (value == null || value === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function resolveSavedProxyTarget(url) {
    return store.savedProxyTarget({
      deviceKey: url.searchParams.get("device") ?? url.searchParams.get("psn"),
      targetUrl: url.searchParams.get("target"),
    });
  }

  async function proxyFetch(req, res, targetUrl) {
    const response = await fetchTarget(targetUrl, { method: req.method, headers: { accept: req.headers.accept ?? "*/*" } });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  return {
    handleHistory,
    statusPayload,
    handleConfig,
    handleSetActiveTarget,
    handleUpdateTarget,
    handleDeleteTarget,
    proxyCurrentTarget,
    proxyRequest,
  };
}
