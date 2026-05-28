import { normalizeTarget } from "./target-security.mjs";

export function createLive({ store, getConfig, runCollector }) {
  const clients = new Set();
  const latestSnapshots = new Map();

  function handleLive(req, res, url) {
    const config = getConfig();
    const target = normalizeTarget(url.searchParams.get("target") ?? config.targetUrl);
    const historyKey = store.resolveHistoryKey(target);
    const savedTarget = store.getTargetByHistoryKey(historyKey, target);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write("retry: 3000\n");
    res.write(": connected\n\n");
    const client = { res, deviceKey: historyKey.deviceKey, target };
    clients.add(client);
    writeSse(res, "status", {
      type: "status",
      targetUrl: target,
      status: savedTarget?.lastStatus ?? "unknown",
      error: savedTarget?.lastError ?? null,
      ts: Date.now(),
      config,
    });
    const snapshot = historyKey.deviceKey ? latestSnapshots.get(historyKey.deviceKey) : null;
    if (snapshot) writeSse(res, "snapshot", snapshot);
    if (!snapshot && savedTarget) runCollector(target);
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": heartbeat\n\n");
    }, 25000);
    req.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
  }

  function broadcast(payload) {
    if (payload.type === "snapshot" && payload.deviceKey) {
      latestSnapshots.set(payload.deviceKey, payload);
    }
    for (const client of clients) {
      if (client.deviceKey && payload.deviceKey && client.deviceKey !== payload.deviceKey) continue;
      if (!client.deviceKey && payload.targetUrl && client.target !== payload.targetUrl) continue;
      writeSse(client.res, payload.type ?? "message", payload);
    }
  }

  function clientCount() {
    return clients.size;
  }

  return { handleLive, broadcast, clientCount };
}

function writeSse(res, event, payload) {
  if (res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
