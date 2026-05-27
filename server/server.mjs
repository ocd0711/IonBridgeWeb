import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(rootDir, "dist");
const dataDir = process.env.IONBRIDGE_DATA_DIR ?? "/data";
const configPath = join(dataDir, "config.json");
const databasePath = join(dataDir, "ionbridge.db");
const historyDir = join(dataDir, "history");
const defaultIntervalMs = 30000;
const retentionDays = Math.max(1, Math.round(Number(process.env.IONBRIDGE_RETENTION_DAYS ?? 30)));
const passwordHash = process.env.IONBRIDGE_PASSWORD
  ? createHash("sha256").update(process.env.IONBRIDGE_PASSWORD).digest("hex")
  : "";
const sessions = new Set();

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
let lastPruneAt = 0;

await mkdir(dataDir, { recursive: true });
const db = openDatabase(databasePath);
await migrateJsonlHistory();
await migrateLegacyConfig();
config = await loadConfig();
pruneHistory(Date.now(), true);
startCollectors();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

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
      if (req.method === "GET") return sendJson(res, { targets: listTargets(), activeTargetUrl: getSetting("active_target_url", "") });
      if (req.method === "DELETE") return handleDeleteTarget(url, res);
    }

    if (url.pathname === "/api/history") return handleHistory(url, res);
    if (url.pathname.startsWith("/device-proxy")) return proxyRequest(req, res, url);
    if (url.pathname.startsWith("/device")) return proxyCurrentTarget(req, res, url);
    return serveStatic(url, res);
  } catch (error) {
    sendJson(res, { error: error instanceof Error ? error.message : "server error" }, 500);
  }
});

server.listen(Number(process.env.PORT ?? 18318), "0.0.0.0");

async function loadConfig() {
  const targets = listTargets();
  const active = getSetting("active_target_url", targets[0]?.targetUrl ?? "");
  const activeTarget = targets.some((target) => target.targetUrl === active) ? active : targets[0]?.targetUrl ?? "";
  const activeEntry = targets.find((target) => target.targetUrl === activeTarget);
  if (activeTarget !== active) setSetting("active_target_url", activeTarget);
  return {
    targetUrl: activeTarget,
    refreshIntervalMs: activeEntry?.refreshIntervalMs ?? clampInterval(Number(getSetting("refresh_interval_ms", defaultIntervalMs))),
    targets,
  };
}

async function migrateLegacyConfig() {
  if (!existsSync(configPath)) return;
  const marker = "legacy-config-v1";
  if (db.prepare("SELECT key FROM migrations WHERE key = ?").get(marker)) return;
  try {
    const raw = parseConfig(await readFile(configPath, "utf8"));
    const targetUrl = normalizeTarget(raw?.targetUrl);
    const refreshIntervalMs = clampInterval(Number(raw?.refreshIntervalMs ?? defaultIntervalMs));
    if (targetUrl) {
      upsertTarget({ targetUrl, refreshIntervalMs, active: true });
      setSetting("refresh_interval_ms", refreshIntervalMs);
      setSetting("active_target_url", targetUrl);
    }
  } catch {
    // A broken legacy config should not prevent the SQLite-backed service from starting.
  }
  db.prepare("INSERT INTO migrations (key, applied_at) VALUES (?, ?)").run(marker, Date.now());
}

function parseConfig(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const recovered = firstJsonObject(raw);
    if (!recovered) throw new Error("config.json is not valid JSON");
    return JSON.parse(recovered);
  }
}

function firstJsonObject(raw) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return raw.slice(start, index + 1);
  }
  return null;
}

function startCollectors() {
  for (const timer of collectorTimers.values()) clearInterval(timer);
  collectorTimers.clear();
  for (const target of listTargets().filter((item) => item.enabled)) {
    runCollector(target.targetUrl);
    collectorTimers.set(target.targetUrl, setInterval(() => runCollector(target.targetUrl), target.refreshIntervalMs));
  }
}

function runCollector(targetUrl) {
  collectOnce(targetUrl).catch(async (error) => {
    markTargetStatus(targetUrl, "offline", error instanceof Error ? error.message : "collection failed");
    config = await loadConfig();
  });
}

async function collectOnce(targetUrl) {
  const normalizedTarget = normalizeTarget(targetUrl);
  if (collectingTargets.has(normalizedTarget)) return;
  collectingTargets.add(normalizedTarget);
  try {
    const metrics = await fetchJson(new URL("/metrics.json", normalizedTarget).toString(), 8000);
    const ts = Date.now();
    const machineInfo = await fetchMachineInfo(normalizedTarget).catch(() => null);
    const deviceKey = resolveDeviceKey(normalizedTarget, machineInfo);
    if (deviceKey) upsertDevice({ deviceKey, machineInfo, target: normalizedTarget, ts });
    markTargetStatus(normalizedTarget, "online", null, { deviceKey, seenAt: ts });
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
  } catch {
    markTargetStatus(normalizedTarget, "offline", "target unreachable");
  } finally {
    config = await loadConfig();
    collectingTargets.delete(normalizedTarget);
  }
}

function openDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_key TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_samples_target_ts ON samples(target, ts);
    CREATE INDEX IF NOT EXISTS idx_samples_target_port_ts ON samples(target, port, ts);
    CREATE INDEX IF NOT EXISTS idx_samples_device_ts ON samples(device_key, ts);
    CREATE INDEX IF NOT EXISTS idx_samples_device_port_ts ON samples(device_key, port, ts);
    CREATE TABLE IF NOT EXISTS devices (
      device_key TEXT PRIMARY KEY,
      psn TEXT,
      device_name TEXT,
      mdns_hostname TEXT,
      last_target TEXT NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS migrations (
      key TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS targets (
      target_url TEXT PRIMARY KEY,
      label TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      refresh_interval_ms INTEGER NOT NULL DEFAULT 30000,
      device_key TEXT,
      last_status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT,
      last_seen INTEGER,
      last_sample_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  ensureColumn(database, "samples", "device_key", "TEXT");
  ensureColumn(database, "targets", "label", "TEXT");
  ensureColumn(database, "targets", "enabled", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(database, "targets", "refresh_interval_ms", "INTEGER NOT NULL DEFAULT 30000");
  ensureColumn(database, "targets", "device_key", "TEXT");
  ensureColumn(database, "targets", "last_status", "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(database, "targets", "last_error", "TEXT");
  ensureColumn(database, "targets", "last_seen", "INTEGER");
  ensureColumn(database, "targets", "last_sample_at", "INTEGER");
  ensureColumn(database, "targets", "created_at", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "targets", "updated_at", "INTEGER NOT NULL DEFAULT 0");
  database.prepare("UPDATE samples SET device_key = NULL WHERE device_key = '' OR device_key LIKE 'http://%' OR device_key LIKE 'https://%'").run();
  database.prepare("DELETE FROM devices WHERE device_key LIKE 'http://%' OR device_key LIKE 'https://%'").run();
  return database;
}

function ensureColumn(database, table, column, type) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((info) => info.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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
    SELECT target_url targetUrl, label, enabled, refresh_interval_ms refreshIntervalMs,
      device_key deviceKey, last_status lastStatus, last_error lastError,
      last_seen lastSeen, last_sample_at lastSampleAt
    FROM targets
    ORDER BY updated_at DESC, created_at DESC
  `).all().map((target) => ({
    ...target,
    enabled: Boolean(target.enabled),
    refreshIntervalMs: clampInterval(Number(target.refreshIntervalMs)),
  }));
}

function upsertTarget({ targetUrl, refreshIntervalMs, active }) {
  const normalizedTarget = normalizeTarget(targetUrl);
  if (!normalizedTarget) throw new Error("targetUrl is required");
  const now = Date.now();
  db.prepare(`
    INSERT INTO targets (target_url, enabled, refresh_interval_ms, created_at, updated_at)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(target_url) DO UPDATE SET
      enabled = 1,
      refresh_interval_ms = excluded.refresh_interval_ms,
      updated_at = excluded.updated_at
  `).run(normalizedTarget, clampInterval(Number(refreshIntervalMs ?? defaultIntervalMs)), now, now);
  if (active) setSetting("active_target_url", normalizedTarget);
}

function markTargetStatus(targetUrl, status, error, details = {}) {
  const normalizedTarget = normalizeTarget(targetUrl);
  const now = Date.now();
  db.prepare(`
    UPDATE targets
    SET last_status = ?, last_error = ?, device_key = COALESCE(?, device_key),
      last_seen = COALESCE(?, last_seen), last_sample_at = COALESCE(?, last_sample_at),
      updated_at = ?
    WHERE target_url = ?
  `).run(
    status,
    error,
    details.deviceKey ?? null,
    details.seenAt ?? null,
    status === "online" ? details.seenAt ?? now : null,
    now,
    normalizedTarget,
  );
}

function insertSamples(rows) {
  if (rows.length === 0) return;
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
  const html = await fetchText(new URL("/", normalizeTarget(target)).toString(), 4000);
  const match = html.match(/window\.__INFOZ=(\{.*?\});/);
  if (!match) throw new Error("window.__INFOZ not found");
  return JSON.parse(match[1]);
}

function resolveDeviceKey(target, machineInfo) {
  return normalizeDeviceKey(machineInfo?.psn);
}

function normalizeDeviceKey(value) {
  const key = String(value ?? "").trim();
  if (!key || key.toLowerCase() === "unknown") return null;
  return key;
}

function upsertDevice({ deviceKey, machineInfo, target, ts }) {
  db.prepare(`
    INSERT INTO devices (device_key, psn, device_name, mdns_hostname, last_target, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_key) DO UPDATE SET
      psn = excluded.psn,
      device_name = excluded.device_name,
      mdns_hostname = excluded.mdns_hostname,
      last_target = excluded.last_target,
      last_seen = excluded.last_seen
  `).run(
    deviceKey,
    normalizeDeviceKey(machineInfo?.psn),
    machineInfo?.device_name ?? null,
    machineInfo?.mdns_hostname ?? null,
    normalizeTarget(target),
    ts,
  );
  db.prepare(`
    UPDATE samples
    SET device_key = ?
    WHERE target = ? AND (device_key IS NULL OR device_key = '')
  `).run(deviceKey, normalizeTarget(target));
}

function pruneHistory(now, force = false) {
  if (!force && now - lastPruneAt < 60 * 60 * 1000) return;
  lastPruneAt = now;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM samples WHERE ts < ?").run(cutoff);
}

async function migrateJsonlHistory() {
  if (!existsSync(historyDir)) return;
  const marker = "jsonl-history-v1";
  const migrated = db.prepare("SELECT key FROM migrations WHERE key = ?").get(marker);
  if (migrated) return;

  const rows = [];
  for (const entry of await readdir(historyDir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const raw = await readFile(join(historyDir, entry), "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        rows.push({
          device_key: normalizeDeviceKey(parsed.psn),
          ts: parsed.ts,
          target: parsed.target,
          port: parsed.port,
          voltage: parsed.voltage,
          current: parsed.current,
          temperature_c: parsed.temperature_c,
          power_w: parsed.power_w,
          attached: parsed.attached ? 1 : 0,
          protocol: parsed.protocol,
        });
      } catch {
        // Ignore broken legacy rows.
      }
    }
  }
  insertSamples(rows.filter((row) => Number.isFinite(row.ts) && row.target && Number.isFinite(row.port)));
  db.prepare("INSERT INTO migrations (key, applied_at) VALUES (?, ?)").run(marker, Date.now());
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

  const device = db.prepare(`
    SELECT device_key FROM devices
    WHERE last_target = ?
    ORDER BY last_seen DESC
    LIMIT 1
  `).get(normalizedTarget);
  if (device?.device_key) return { deviceKey: device.device_key, target: normalizedTarget };

  const sample = db.prepare(`
    SELECT device_key FROM samples
    WHERE target = ? AND device_key IS NOT NULL AND device_key != ''
    ORDER BY ts DESC
    LIMIT 1
  `).get(normalizedTarget);
  return { deviceKey: sample?.device_key ?? null, target: normalizedTarget };
}

function queryHistory({ deviceKey, target, start, end, portFilter }) {
  const identityWhere = deviceKey ? "(device_key = ? OR target = ?)" : "target = ?";
  const sql = portFilter
    ? `SELECT ts, target, port, voltage, current, temperature_c, power_w, attached, protocol
       FROM samples
       WHERE ${identityWhere} AND port = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`
    : `SELECT ts, target, port, voltage, current, temperature_c, power_w, attached, protocol
       FROM samples
       WHERE ${identityWhere} AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`;
  const identityArgs = deviceKey ? [deviceKey, target] : [target];
  const rows = portFilter
    ? db.prepare(sql).all(...identityArgs, Number(portFilter), start, end)
    : db.prepare(sql).all(...identityArgs, start, end);
  return rows.map((row) => ({ ...row, attached: Boolean(row.attached) }));
}

async function handleConfig(req, res) {
  const body = await readJson(req);
  const targetUrl = normalizeTarget(body.targetUrl ?? config.targetUrl);
  if (!targetUrl) return sendJson(res, { error: "targetUrl is required" }, 400);
  const refreshIntervalMs = clampInterval(Number(body.refreshIntervalMs ?? config.refreshIntervalMs));
  upsertTarget({ targetUrl, refreshIntervalMs, active: true });
  setSetting("refresh_interval_ms", refreshIntervalMs);
  config = await loadConfig();
  startCollectors();
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
  db.prepare("DELETE FROM targets WHERE target_url = ?").run(targetUrl);
  db.prepare("DELETE FROM samples WHERE target = ?").run(targetUrl);
  if (deviceKey) {
    const remainingSamples = db.prepare("SELECT 1 FROM samples WHERE device_key = ? LIMIT 1").get(deviceKey);
    const remainingTargets = db.prepare("SELECT 1 FROM targets WHERE device_key = ? LIMIT 1").get(deviceKey);
    if (!remainingSamples && !remainingTargets) {
      db.prepare("DELETE FROM devices WHERE device_key = ?").run(deviceKey);
    }
  }
  if (getSetting("active_target_url", "") === targetUrl) {
    const nextTarget = listTargets()[0]?.targetUrl ?? "";
    setSetting("active_target_url", nextTarget);
  }
  config = await loadConfig();
  startCollectors();
  sendJson(res, config);
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  if (!passwordHash || verifyPassword(body.password ?? "")) {
    const session = randomBytes(24).toString("hex");
    sessions.add(session);
    res.setHeader("Set-Cookie", `ionbridge_session=${session}; Path=/; HttpOnly; SameSite=Lax`);
    return sendJson(res, sessionPayload({ headers: { cookie: `ionbridge_session=${session}` } }));
  }
  sendJson(res, { error: "invalid password" }, 401);
}

function handleLogout(req, res) {
  const session = getCookie(req, "ionbridge_session");
  if (session) sessions.delete(session);
  res.setHeader("Set-Cookie", "ionbridge_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
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
  const target = url.searchParams.get("target");
  if (!target) return sendJson(res, { error: "missing target" }, 400);
  url.searchParams.delete("target");
  const path = url.pathname.replace(/^\/device-proxy/, "") || "/";
  const targetUrl = new URL(`${path}${url.search}`, normalizeTarget(target));
  return proxyFetch(req, res, targetUrl);
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
  for await (const chunk of req) chunks.push(chunk);
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
  return Boolean(session && sessions.has(session));
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
