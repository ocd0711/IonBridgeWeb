import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(rootDir, "dist");
const dataDir = process.env.IONBRIDGE_DATA_DIR ?? "/data";
const configPath = join(dataDir, "config.json");
const historyDir = join(dataDir, "history");
const defaultTarget = process.env.IONBRIDGE_TARGET ?? "http://192.168.217.161";
const defaultIntervalMs = Number(process.env.IONBRIDGE_REFRESH_MS ?? 30000);
const retentionDays = Math.max(1, Math.round(Number(process.env.IONBRIDGE_RETENTION_DAYS ?? 30)));
const passwordHash = process.env.IONBRIDGE_PASSWORD
  ? createHash("sha256").update(process.env.IONBRIDGE_PASSWORD).digest("hex")
  : "";
const sessions = new Set();

let config = {
  targetUrl: normalizeTarget(defaultTarget),
  refreshIntervalMs: clampInterval(defaultIntervalMs),
};
let collectorTimer;
let lastPruneAt = 0;
let collecting = false;

await mkdir(historyDir, { recursive: true });
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
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    return {
      targetUrl: normalizeTarget(raw.targetUrl ?? defaultTarget),
      refreshIntervalMs: clampInterval(Number(raw.refreshIntervalMs ?? defaultIntervalMs)),
    };
  } catch {
    await saveConfig(config);
    return config;
  }
}

async function saveConfig(nextConfig) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(nextConfig, null, 2));
}

function startCollector() {
  if (collectorTimer) clearInterval(collectorTimer);
  collectOnce();
  collectorTimer = setInterval(collectOnce, config.refreshIntervalMs);
}

async function collectOnce() {
  if (collecting) return;
  collecting = true;
  try {
    const metrics = await fetchJson(new URL("/metrics.json", config.targetUrl).toString(), 8000);
    const ts = Date.now();
    const targetKey = targetHistoryKey(config.targetUrl);
    const rows = metrics.ports.map((port) => JSON.stringify({
      ts,
      target: config.targetUrl,
      port: port.id,
      voltage: port.voltage,
      current: port.current,
      temperature_c: port.die_temperature,
      power_w: (port.voltage * port.current) / 1_000_000,
      attached: port.attached,
      protocol: port.fc_protocol,
    })).join("\n");
    await appendFile(join(historyDir, `${targetKey}.jsonl`), `${rows}\n`);
    await pruneHistoryFile(targetKey, ts);
  } catch {
    // Keep the service running. The next interval retries.
  } finally {
    collecting = false;
  }
}

async function pruneHistoryFile(targetKey, now) {
  if (now - lastPruneAt < 60 * 60 * 1000) return;
  lastPruneAt = now;
  const file = join(historyDir, `${targetKey}.jsonl`);
  const tmp = `${file}.tmp`;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  try {
    const raw = await readFile(file, "utf8");
    const kept = raw.split("\n").filter((line) => {
      if (!line) return false;
      try {
        return JSON.parse(line).ts >= cutoff;
      } catch {
        return false;
      }
    });
    await writeFile(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    await rename(tmp, file);
  } catch {
    // Pruning is best effort. Collection should not stop if the history file is being rotated.
  }
}

async function handleHistory(url, res) {
  const target = normalizeTarget(url.searchParams.get("target") ?? config.targetUrl);
  const hours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("hours") ?? 24)));
  const portFilter = url.searchParams.get("port");
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const file = join(historyDir, `${targetHistoryKey(target)}.jsonl`);
  let rows = [];
  try {
    const raw = await readFile(file, "utf8");
    rows = raw.split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.ts >= cutoff && (!portFilter || String(row.port) === portFilter));
  } catch {
    rows = [];
  }
  sendJson(res, { target, hours, rows });
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

function targetHistoryKey(target) {
  return createHash("sha256").update(normalizeTarget(target)).digest("hex").slice(0, 20);
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
