import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
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
const defaultTarget = process.env.IONBRIDGE_TARGET ?? "http://192.168.217.161";
const defaultIntervalMs = Number(process.env.IONBRIDGE_REFRESH_MS ?? 30000);
const retentionDays = Math.max(1, Math.round(Number(process.env.IONBRIDGE_RETENTION_DAYS ?? 30)));
const passwordHash = process.env.IONBRIDGE_PASSWORD
  ? createHash("sha256").update(process.env.IONBRIDGE_PASSWORD).digest("hex")
  : "";
const sessions = new Set();

process.on("unhandledRejection", (error) => {
  console.warn("[ionbridge] background task failed:", error);
});

let config = {
  targetUrl: normalizeTarget(defaultTarget),
  refreshIntervalMs: clampInterval(defaultIntervalMs),
};
let collectorTimer;
let lastPruneAt = 0;
let collecting = false;

await mkdir(dataDir, { recursive: true });
const db = openDatabase(databasePath);
await migrateJsonlHistory();
config = await loadConfig();
startCollector();

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
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = parseConfig(raw);
    const nextConfig = normalizeConfig(parsed);
    if (raw.trim() !== JSON.stringify(nextConfig, null, 2)) {
      await saveConfig(nextConfig);
    }
    return nextConfig;
  } catch {
    await saveConfig(config);
    return config;
  }
}

async function saveConfig(nextConfig) {
  await mkdir(dataDir, { recursive: true });
  const tmpPath = `${configPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(normalizeConfig(nextConfig), null, 2)}\n`, { flag: "wx" });
  await rename(tmpPath, configPath);
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

function normalizeConfig(raw) {
  return {
    targetUrl: normalizeTarget(raw?.targetUrl ?? defaultTarget),
    refreshIntervalMs: clampInterval(Number(raw?.refreshIntervalMs ?? defaultIntervalMs)),
  };
}

function startCollector() {
  if (collectorTimer) clearInterval(collectorTimer);
  runCollector();
  collectorTimer = setInterval(runCollector, config.refreshIntervalMs);
}

function runCollector() {
  collectOnce().catch((error) => {
    console.warn("[ionbridge] metrics collection failed:", error);
  });
}

async function collectOnce() {
  if (collecting) return;
  collecting = true;
  try {
    const metrics = await fetchJson(new URL("/metrics.json", config.targetUrl).toString(), 8000);
    const ts = Date.now();
    const machineInfo = await fetchMachineInfo(config.targetUrl).catch(() => null);
    const deviceKey = resolveDeviceKey(config.targetUrl, machineInfo);
    upsertDevice({ deviceKey, machineInfo, target: config.targetUrl, ts });
    insertSamples(metrics.ports.map((port) => ({
      device_key: deviceKey,
      ts,
      target: config.targetUrl,
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
    // Keep the service running. The next interval retries.
  } finally {
    collecting = false;
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
  `);
  ensureColumn(database, "samples", "device_key", "TEXT");
  database.prepare("UPDATE samples SET device_key = target WHERE device_key IS NULL OR device_key = ''").run();
  return database;
}

function ensureColumn(database, table, column, type) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((info) => info.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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
  return normalizeDeviceKey(machineInfo?.psn) ?? normalizeTarget(target);
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
    WHERE target = ? AND (device_key IS NULL OR device_key = '' OR device_key = target)
  `).run(deviceKey, normalizeTarget(target));
}

function pruneHistory(now) {
  if (now - lastPruneAt < 60 * 60 * 1000) return;
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
          device_key: normalizeTarget(parsed.target),
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
  const deviceKey = resolveHistoryDeviceKey(target);
  const rows = queryHistory({ deviceKey, start, end, portFilter });
  sendJson(res, { target, deviceKey, hours, start, end, rows });
}

function parseOptionalTimestamp(value) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveHistoryDeviceKey(target) {
  const normalizedTarget = normalizeTarget(target);
  const device = db.prepare(`
    SELECT device_key FROM devices
    WHERE last_target = ?
    ORDER BY last_seen DESC
    LIMIT 1
  `).get(normalizedTarget);
  if (device?.device_key) return device.device_key;

  const sample = db.prepare(`
    SELECT device_key FROM samples
    WHERE target = ?
    ORDER BY ts DESC
    LIMIT 1
  `).get(normalizedTarget);
  return sample?.device_key ?? normalizedTarget;
}

function queryHistory({ deviceKey, start, end, portFilter }) {
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
  config = {
    targetUrl: normalizeTarget(body.targetUrl ?? config.targetUrl),
    refreshIntervalMs: clampInterval(Number(body.refreshIntervalMs ?? config.refreshIntervalMs)),
  };
  await saveConfig(config);
  startCollector();
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
  const trimmed = String(target || defaultTarget).trim().replace(/\/+$/, "");
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
