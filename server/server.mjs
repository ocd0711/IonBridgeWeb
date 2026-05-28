import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(rootDir, "dist");
const dataDir = process.env.IONBRIDGE_DATA_DIR ?? "/data";
const databasePath = join(dataDir, "ionbridge.db");
const defaultIntervalMs = 30000;
const deviceIdentityTimeoutMs = 10000;
const retentionDays = Math.max(1, Math.round(Number(process.env.IONBRIDGE_RETENTION_DAYS ?? 30)));
const passwordHash = process.env.IONBRIDGE_PASSWORD
  ? createHash("sha256").update(process.env.IONBRIDGE_PASSWORD).digest("hex")
  : "";
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const maxLoginFailures = 5;
const loginFailureWindowMs = 60 * 1000;
const maxJsonBodyBytes = 64 * 1024;
const sessions = new Map();
const loginFailures = new Map();

process.on("unhandledRejection", (error) => {
  console.warn("[ionbridge] background task failed:", error);
});

let config = {
  targetUrl: "",
  refreshIntervalMs: defaultIntervalMs,
  targets: [],
};
const collectorTimers = new Map();
const collectingTargets = new Set();
const liveClients = new Set();
const latestSnapshots = new Map();
let lastPruneAt = 0;

await mkdir(dataDir, { recursive: true });
const db = openDatabase(databasePath);
config = await loadConfig();
pruneHistory(Date.now(), true);
startCollectors();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    applySecurityHeaders(res);

    if (url.pathname === "/health") return sendJson(res, { ok: true });
    if (url.pathname === "/api/session") return sendJson(res, sessionPayload(req));
    if (url.pathname === "/api/login" && req.method === "POST") return handleLogin(req, res);
    if (url.pathname === "/api/logout" && req.method === "POST") return handleLogout(req, res);

    if (passwordHash && !isAuthenticated(req)) {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/device")) {
        return sendJson(res, { error: "unauthorized" }, 401);
      }
    }

    if (url.pathname === "/api/config") {
      if (req.method === "GET") return sendJson(res, config);
      if (req.method === "PUT") return handleConfig(req, res);
    }

    if (url.pathname === "/api/targets") {
      if (req.method === "GET") return sendJson(res, { targets: listTargets(), activeTargetUrl: config.targetUrl });
      if (req.method === "POST") return handleSetActiveTarget(req, res);
      if (req.method === "DELETE") return handleDeleteTarget(url, res);
    }

    if (url.pathname === "/api/history") return handleHistory(url, res);
    if (url.pathname === "/api/live") return handleLive(req, res, url);
    if (url.pathname.startsWith("/device-proxy")) return proxyRequest(req, res, url);
    if (url.pathname.startsWith("/device")) return proxyCurrentTarget(req, res, url);
    return serveStatic(url, res);
  } catch (error) {
    if (error instanceof Error && error.message === "request body too large") {
      return sendJson(res, { error: error.message }, 413);
    }
    if (error instanceof SyntaxError) {
      return sendJson(res, { error: "invalid json" }, 400);
    }
    sendJson(res, { error: error instanceof Error ? error.message : "server error" }, 500);
  }
});

server.listen(Number(process.env.PORT ?? 18318), "0.0.0.0");

async function loadConfig() {
  const targets = listTargets();
  const active = getSetting("active_device_key", targets[0]?.deviceKey ?? "");
  const activeEntry = targets.find((target) => target.deviceKey === active) ?? targets[0] ?? null;
  if ((activeEntry?.deviceKey ?? "") !== active) setSetting("active_device_key", activeEntry?.deviceKey ?? "");
  return {
    targetUrl: activeEntry?.targetUrl ?? "",
    refreshIntervalMs: activeEntry?.refreshIntervalMs ?? defaultIntervalMs,
    targets,
  };
}

function startCollectors() {
  for (const timer of collectorTimers.values()) clearInterval(timer);
  collectorTimers.clear();
  for (const target of listTargets()) {
    runCollector(target.targetUrl);
    collectorTimers.set(target.targetUrl, setInterval(() => runCollector(target.targetUrl), target.refreshIntervalMs));
  }
}

function runCollector(targetUrl) {
  collectOnce(targetUrl).catch(async (error) => {
    markTargetStatusByTarget(targetUrl, "offline", error instanceof Error ? error.message : "collection failed");
    config = await loadConfig();
  });
}

async function collectOnce(targetUrl) {
  const normalizedTarget = normalizeTarget(targetUrl);
  if (collectingTargets.has(normalizedTarget)) return;
  collectingTargets.add(normalizedTarget);
  try {
    const machineInfo = await fetchMachineInfo(normalizedTarget);
    const deviceKey = requireDeviceKey(machineInfo);
    const [metrics, heap] = await Promise.all([
      fetchJson(new URL("/metrics.json", normalizedTarget).toString(), 8000),
      fetchJson(new URL("/heapz", normalizedTarget).toString(), 3500).catch(() => null),
    ]);
    const ts = Date.now();
    markTargetStatus(deviceKey, "online", null, { seenAt: ts });
    insertSamples(metrics.ports.map((port) => ({
      device_key: deviceKey,
      ts,
      target: normalizedTarget,
      port: port.id,
      voltage: port.voltage,
      current: port.current,
      temperature_c: port.die_temperature,
      power_w: (port.voltage * port.current) / 1_000_000,
      attached: port.attached ? 1 : 0,
      protocol: port.fc_protocol,
    })));
    pruneHistory(ts);
    config = await loadConfig();
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
    latestSnapshots.set(deviceKey, snapshot);
    broadcastLive(snapshot);
  } catch {
    markTargetStatusByTarget(normalizedTarget, "offline", "target unreachable");
    config = await loadConfig();
    broadcastLive({
      type: "status",
      targetUrl: normalizedTarget,
      status: "offline",
      error: "target unreachable",
      ts: Date.now(),
      config,
    });
  } finally {
    config = await loadConfig();
    collectingTargets.delete(normalizedTarget);
  }
}

function openDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    DROP TABLE IF EXISTS devices;
    DROP TABLE IF EXISTS migrations;
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_key TEXT NOT NULL,
      target TEXT NOT NULL,
      ts INTEGER NOT NULL,
      port INTEGER NOT NULL,
      voltage INTEGER,
      current INTEGER,
      temperature_c REAL,
      power_w REAL,
      attached INTEGER,
      protocol TEXT
    );
  `);
  if (!tableHasRequiredColumns(database, "samples", ["device_key", "target", "ts", "port"]) || !columnIsNotNull(database, "samples", "device_key")) {
    database.exec(`
      DROP TABLE IF EXISTS samples_v2;
      CREATE TABLE samples_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_key TEXT NOT NULL,
        target TEXT NOT NULL,
        ts INTEGER NOT NULL,
        port INTEGER NOT NULL,
        voltage INTEGER,
        current INTEGER,
        temperature_c REAL,
        power_w REAL,
        attached INTEGER,
        protocol TEXT
      );
      INSERT INTO samples_v2 (
        device_key, target, ts, port, voltage, current, temperature_c, power_w, attached, protocol
      )
      SELECT device_key, target, ts, port, voltage, current, temperature_c, power_w, attached, protocol
      FROM samples
      WHERE device_key IS NOT NULL
        AND device_key != ''
        AND device_key NOT LIKE 'http://%'
        AND device_key NOT LIKE 'https://%';
      DROP TABLE samples;
      ALTER TABLE samples_v2 RENAME TO samples;
    `);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_samples_device_ts ON samples(device_key, ts);
    CREATE INDEX IF NOT EXISTS idx_samples_device_port_ts ON samples(device_key, port, ts);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS targets (
      device_key TEXT PRIMARY KEY,
      target_url TEXT NOT NULL UNIQUE,
      refresh_interval_ms INTEGER NOT NULL DEFAULT 30000,
      last_status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT,
      last_seen INTEGER,
      last_sample_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  if (!targetsSchemaIsCurrent(database)) {
    database.exec(`
      DROP TABLE IF EXISTS targets_v2;
      CREATE TABLE targets_v2 (
        device_key TEXT PRIMARY KEY,
        target_url TEXT NOT NULL UNIQUE,
        refresh_interval_ms INTEGER NOT NULL DEFAULT 30000,
        last_status TEXT NOT NULL DEFAULT 'unknown',
        last_error TEXT,
        last_seen INTEGER,
        last_sample_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR REPLACE INTO targets_v2 (
        device_key, target_url, refresh_interval_ms, last_status, last_error,
        last_seen, last_sample_at, created_at, updated_at
      )
      SELECT device_key, target_url, refresh_interval_ms,
        COALESCE(last_status, 'unknown'), last_error, last_seen, last_sample_at,
        COALESCE(NULLIF(created_at, 0), strftime('%s','now') * 1000),
        COALESCE(NULLIF(updated_at, 0), strftime('%s','now') * 1000)
      FROM targets
      WHERE device_key IS NOT NULL
        AND device_key != ''
        AND device_key NOT LIKE 'http://%'
        AND device_key NOT LIKE 'https://%';
      DROP TABLE targets;
      ALTER TABLE targets_v2 RENAME TO targets;
    `);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_targets_target_url ON targets(target_url);
  `);
  database.prepare("DELETE FROM settings WHERE key = ?").run("active_target_url");
  database.prepare("DELETE FROM settings WHERE key = ?").run("refresh_interval_ms");
  return database;
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableColumns(database, table) {
  if (!tableExists(database, table)) return [];
  return database.prepare(`PRAGMA table_info(${table})`).all();
}

function tableHasRequiredColumns(database, table, columns) {
  const names = new Set(tableColumns(database, table).map((column) => column.name));
  return columns.every((column) => names.has(column));
}

function columnIsNotNull(database, table, columnName) {
  const column = tableColumns(database, table).find((info) => info.name === columnName);
  return Boolean(column?.notnull);
}

function targetsSchemaIsCurrent(database) {
  const columns = tableColumns(database, "targets");
  const names = new Set(columns.map((column) => column.name));
  const deviceKey = columns.find((column) => column.name === "device_key");
  return (
    names.has("device_key") &&
    names.has("target_url") &&
    names.has("refresh_interval_ms") &&
    names.has("last_status") &&
    !names.has("label") &&
    !names.has("enabled") &&
    Boolean(deviceKey?.pk)
  );
}

function getSetting(key, fallback) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function listTargets() {
  return db.prepare(`
    SELECT target_url targetUrl, refresh_interval_ms refreshIntervalMs,
      device_key deviceKey, last_status lastStatus, last_error lastError,
      last_seen lastSeen, last_sample_at lastSampleAt
    FROM targets
    ORDER BY updated_at DESC, created_at DESC
  `).all().map((target) => ({
    ...target,
    refreshIntervalMs: clampInterval(Number(target.refreshIntervalMs)),
  }));
}

function upsertVerifiedTarget({ deviceKey, targetUrl, refreshIntervalMs, active, status = "online", error = null }) {
  const normalizedTarget = normalizeTarget(targetUrl);
  if (!normalizedTarget) throw new Error("targetUrl is required");
  const normalizedDeviceKey = normalizeDeviceKey(deviceKey);
  if (!normalizedDeviceKey) throw new Error("PSN is required");
  const now = Date.now();
  db.prepare("DELETE FROM targets WHERE target_url = ? AND device_key != ?").run(normalizedTarget, normalizedDeviceKey);
  db.prepare(`
    INSERT INTO targets (
      device_key, target_url, refresh_interval_ms, last_status, last_error,
      last_seen, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_key) DO UPDATE SET
      target_url = excluded.target_url,
      refresh_interval_ms = excluded.refresh_interval_ms,
      last_status = excluded.last_status,
      last_error = excluded.last_error,
      last_seen = excluded.last_seen,
      updated_at = excluded.updated_at
  `).run(
    normalizedDeviceKey,
    normalizedTarget,
    clampInterval(Number(refreshIntervalMs ?? defaultIntervalMs)),
    status,
    error,
    status === "online" ? now : null,
    now,
    now,
  );
  if (active) setSetting("active_device_key", normalizedDeviceKey);
}

function markTargetStatus(deviceKey, status, error, details = {}) {
  const normalizedDeviceKey = normalizeDeviceKey(deviceKey);
  if (!normalizedDeviceKey) return;
  const now = Date.now();
  db.prepare(`
    UPDATE targets
    SET last_status = ?, last_error = ?,
      last_seen = COALESCE(?, last_seen), last_sample_at = COALESCE(?, last_sample_at),
      updated_at = ?
    WHERE device_key = ?
  `).run(
    status,
    error,
    details.seenAt ?? null,
    status === "online" ? details.seenAt ?? now : null,
    now,
    normalizedDeviceKey,
  );
}

function markTargetStatusByTarget(targetUrl, status, error) {
  const normalizedTarget = normalizeTarget(targetUrl);
  const now = Date.now();
  db.prepare(`
    UPDATE targets
    SET last_status = ?, last_error = ?, updated_at = ?
    WHERE target_url = ?
  `).run(status, error, now, normalizedTarget);
}

function insertSamples(rows) {
  if (rows.length === 0) return;
  if (rows.some((row) => !normalizeDeviceKey(row.device_key))) {
    throw new Error("samples require a valid PSN device_key");
  }
  const insert = db.prepare(`
    INSERT INTO samples (
      device_key, target, ts, port, voltage, current, temperature_c, power_w, attached, protocol
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      insert.run(
        row.device_key,
        normalizeTarget(row.target),
        row.ts,
        row.port,
        row.voltage,
        row.current,
        row.temperature_c,
        row.power_w,
        row.attached,
        row.protocol,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function fetchMachineInfo(target) {
  const html = await fetchText(new URL("/", normalizeTarget(target)).toString(), deviceIdentityTimeoutMs);
  const match = html.match(/window\.__INFOZ=(\{.*?\});/);
  if (!match) throw new Error("window.__INFOZ not found");
  return JSON.parse(match[1]);
}

function normalizeDeviceKey(value) {
  const key = String(value ?? "").trim();
  if (!key || key.toLowerCase() === "unknown") return null;
  return key;
}

function requireDeviceKey(machineInfo) {
  const deviceKey = normalizeDeviceKey(machineInfo?.psn);
  if (!deviceKey) throw new Error("target did not expose a valid PSN");
  return deviceKey;
}

function pruneHistory(now, force = false) {
  if (!force && now - lastPruneAt < 60 * 60 * 1000) return;
  lastPruneAt = now;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM samples WHERE ts < ?").run(cutoff);
}

async function handleHistory(url, res) {
  const target = normalizeTarget(url.searchParams.get("target") ?? config.targetUrl);
  const hours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("hours") ?? 24)));
  const startParam = parseOptionalTimestamp(url.searchParams.get("start"));
  const endParam = parseOptionalTimestamp(url.searchParams.get("end"));
  const portFilter = url.searchParams.get("port");
  const now = Date.now();
  const start = startParam ?? now - hours * 60 * 60 * 1000;
  const end = endParam ?? now;
  const historyKey = resolveHistoryKey(target);
  const rows = queryHistory({ ...historyKey, start, end, portFilter });
  sendJson(res, { target, deviceKey: historyKey.deviceKey, hours, start, end, rows });
}

function handleLive(req, res, url) {
  const target = normalizeTarget(url.searchParams.get("target") ?? config.targetUrl);
  const historyKey = resolveHistoryKey(target);
  const savedTarget = getTargetByHistoryKey(historyKey, target);
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
  liveClients.add(client);
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
    liveClients.delete(client);
  });
}

function getTargetByHistoryKey(historyKey, target) {
  if (historyKey.deviceKey) {
    return db.prepare(`
      SELECT last_status lastStatus, last_error lastError
      FROM targets
      WHERE device_key = ?
    `).get(historyKey.deviceKey);
  }
  return db.prepare(`
    SELECT last_status lastStatus, last_error lastError
    FROM targets
    WHERE target_url = ?
  `).get(target);
}

function broadcastLive(payload) {
  for (const client of liveClients) {
    if (client.deviceKey && payload.deviceKey && client.deviceKey !== payload.deviceKey) continue;
    if (!client.deviceKey && payload.targetUrl && client.target !== payload.targetUrl) continue;
    writeSse(client.res, payload.type ?? "message", payload);
  }
}

function writeSse(res, event, payload) {
  if (res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseOptionalTimestamp(value) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveHistoryKey(target) {
  const normalizedTarget = normalizeTarget(target);
  const savedTarget = db.prepare(`
    SELECT device_key FROM targets
    WHERE target_url = ? AND device_key IS NOT NULL AND device_key != ''
    LIMIT 1
  `).get(normalizedTarget);
  if (savedTarget?.device_key) return { deviceKey: savedTarget.device_key, target: normalizedTarget };
  return { deviceKey: null, target: normalizedTarget };
}

function queryHistory({ deviceKey, target, start, end, portFilter }) {
  if (!deviceKey) return [];
  const sql = portFilter
    ? `SELECT ts, target, port, voltage, current, temperature_c, power_w, attached, protocol
       FROM samples
       WHERE device_key = ? AND port = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`
    : `SELECT ts, target, port, voltage, current, temperature_c, power_w, attached, protocol
       FROM samples
       WHERE device_key = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`;
  const rows = portFilter
    ? db.prepare(sql).all(deviceKey, Number(portFilter), start, end)
    : db.prepare(sql).all(deviceKey, start, end);
  return rows.map((row) => ({ ...row, attached: Boolean(row.attached) }));
}

async function handleConfig(req, res) {
  const body = await readJson(req);
  const targetUrl = normalizeTarget(body.targetUrl ?? config.targetUrl);
  if (!targetUrl) return sendJson(res, { error: "targetUrl is required" }, 400);
  const refreshIntervalMs = clampInterval(Number(body.refreshIntervalMs ?? config.refreshIntervalMs));
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
  upsertVerifiedTarget({ deviceKey, targetUrl, refreshIntervalMs, active: true });
  config = await loadConfig();
  startCollectors();
  sendJson(res, config);
}

async function handleSetActiveTarget(req, res) {
  const body = await readJson(req);
  const targetUrl = normalizeTarget(body.targetUrl);
  if (!targetUrl) return sendJson(res, { error: "targetUrl is required" }, 400);
  const target = db.prepare("SELECT device_key FROM targets WHERE target_url = ?").get(targetUrl);
  if (!target?.device_key) return sendJson(res, { error: "target is not saved" }, 404);
  setSetting("active_device_key", target.device_key);
  config = await loadConfig();
  sendJson(res, config);
}

async function handleDeleteTarget(url, res) {
  const target = url.searchParams.get("target");
  if (!target) return sendJson(res, { error: "missing target" }, 400);
  const targetUrl = normalizeTarget(target);
  const { deviceKey } = resolveHistoryKey(targetUrl);
  if (collectorTimers.has(targetUrl)) {
    clearInterval(collectorTimers.get(targetUrl));
    collectorTimers.delete(targetUrl);
  }
  if (deviceKey) {
    db.prepare("DELETE FROM targets WHERE device_key = ?").run(deviceKey);
    db.prepare("DELETE FROM samples WHERE device_key = ?").run(deviceKey);
  } else {
    db.prepare("DELETE FROM targets WHERE target_url = ?").run(targetUrl);
  }
  if (getSetting("active_device_key", "") === deviceKey) {
    const nextTarget = listTargets()[0]?.deviceKey ?? "";
    setSetting("active_device_key", nextTarget);
  }
  config = await loadConfig();
  startCollectors();
  sendJson(res, config);
}

async function handleLogin(req, res) {
  pruneExpiredSessions();
  const clientAddress = clientAddressOf(req);
  if (isLoginRateLimited(clientAddress)) {
    return sendJson(res, { error: "too many login attempts" }, 429);
  }
  const body = await readJson(req);
  if (!passwordHash || verifyPassword(body.password ?? "")) {
    const session = randomBytes(24).toString("hex");
    sessions.set(session, Date.now() + sessionTtlMs);
    loginFailures.delete(clientAddress);
    res.setHeader("Set-Cookie", sessionCookie(req, session));
    return sendJson(res, sessionPayload({ headers: { cookie: `ionbridge_session=${session}` } }));
  }
  recordLoginFailure(clientAddress);
  sendJson(res, { error: "invalid password" }, 401);
}

function handleLogout(req, res) {
  const session = getCookie(req, "ionbridge_session");
  if (session) sessions.delete(session);
  res.setHeader("Set-Cookie", clearSessionCookie(req));
  sendJson(res, { ok: true });
}

function sessionPayload(req) {
  return {
    passwordEnabled: Boolean(passwordHash),
    authenticated: !passwordHash || isAuthenticated(req),
    config,
  };
}

async function proxyCurrentTarget(req, res, url) {
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

function resolveSavedProxyTarget(url) {
  const deviceKey = normalizeDeviceKey(url.searchParams.get("device") ?? url.searchParams.get("psn"));
  if (deviceKey) {
    return db.prepare("SELECT target_url FROM targets WHERE device_key = ?").get(deviceKey)?.target_url ?? null;
  }
  const target = normalizeTarget(url.searchParams.get("target"));
  if (!target) return null;
  return db.prepare("SELECT target_url FROM targets WHERE target_url = ?").get(target)?.target_url ?? null;
}

async function proxyFetch(req, res, targetUrl) {
  const response = await fetch(targetUrl, { method: req.method, headers: { accept: req.headers.accept ?? "*/*" } });
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (!["content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(url, res) {
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(distDir, requested === "/" ? "index.html" : requested);
  if (!file.startsWith(distDir)) file = join(distDir, "index.html");
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(distDir, "index.html");
  }
  if (!existsSync(file)) return sendText(res, "Not built. Run npm run build first.", 404);
  res.setHeader("Content-Type", contentType(extname(file)));
  createReadStream(file).pipe(res);
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxJsonBodyBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendText(res, text, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
}

function normalizeTarget(target) {
  const trimmed = String(target || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function clampInterval(value) {
  return Math.max(1000, Math.min(60000, Math.round(Number.isFinite(value) ? value : defaultIntervalMs)));
}

function verifyPassword(password) {
  const actual = Buffer.from(createHash("sha256").update(password).digest("hex"));
  const expected = Buffer.from(passwordHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isAuthenticated(req) {
  const session = getCookie(req, "ionbridge_session");
  if (!session) return false;
  const expiresAt = sessions.get(session);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    sessions.delete(session);
    return false;
  }
  return true;
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [session, expiresAt] of sessions) {
    if (now > expiresAt) sessions.delete(session);
  }
}

function isLoginRateLimited(clientAddress) {
  const entry = loginFailures.get(clientAddress);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    loginFailures.delete(clientAddress);
    return false;
  }
  return entry.count >= maxLoginFailures;
}

function recordLoginFailure(clientAddress) {
  const now = Date.now();
  const current = loginFailures.get(clientAddress);
  const next = current && now <= current.resetAt
    ? { count: current.count + 1, resetAt: current.resetAt }
    : { count: 1, resetAt: now + loginFailureWindowMs };
  loginFailures.set(clientAddress, next);
}

function sessionCookie(req, session) {
  const attributes = [
    `ionbridge_session=${session}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
  ];
  if (isHttpsRequest(req)) attributes.push("Secure");
  return attributes.join("; ");
}

function clearSessionCookie(req) {
  const attributes = [
    "ionbridge_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isHttpsRequest(req)) attributes.push("Secure");
  return attributes.join("; ");
}

function isHttpsRequest(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function clientAddressOf(req) {
  return req.socket.remoteAddress ?? "unknown";
}

function getCookie(req, name) {
  const cookie = req.headers.cookie ?? "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function contentType(ext) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  }[ext] ?? "application/octet-stream";
}
