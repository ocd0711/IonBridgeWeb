import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { createCollector } from "./collector.mjs";
import { createStore } from "./db.mjs";
import { createLive } from "./live.mjs";
import { createRoutes } from "./routes.mjs";
import { createTargetFetcher, normalizeTarget } from "./target-security.mjs";

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
const allowTargetRedirects = process.env.IONBRIDGE_ALLOW_TARGET_REDIRECTS === "true";
const maxTargetRedirects = allowTargetRedirects
  ? Math.max(0, Math.min(5, Number(process.env.IONBRIDGE_MAX_TARGET_REDIRECTS ?? 3)))
  : 0;
const fetchTarget = createTargetFetcher({
  allowedTargets: process.env.IONBRIDGE_ALLOWED_TARGETS,
  allowTargetRedirects,
  maxTargetRedirects,
});
const showAppearanceSwitcher = process.env.IONBRIDGE_SHOW_APPEARANCE_SWITCHER === "true";
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
await mkdir(dataDir, { recursive: true });
const store = createStore({ databasePath, defaultIntervalMs, retentionDays });
let collector;
const live = createLive({ store, getConfig: () => config, runCollector: (targetUrl) => collector.runCollector(targetUrl) });
collector = createCollector({
  store,
  fetchMachineInfo,
  fetchJson,
  refreshConfig,
  broadcast: live.broadcast,
});
const routes = createRoutes({
  store,
  collector,
  live,
  getConfig: () => config,
  refreshConfig,
  fetchMachineInfo,
  fetchTarget,
  defaultIntervalMs,
  retentionDays,
  readJson,
  sendJson,
});
config = await loadConfig();
store.pruneHistory(Date.now(), true);
collector.startCollectors();

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
      if (req.method === "PUT") return routes.handleConfig(req, res);
    }

    if (url.pathname === "/api/targets") {
      if (req.method === "GET") return sendJson(res, { targets: store.listTargets(), activeTargetUrl: config.targetUrl });
      if (req.method === "POST") return routes.handleSetActiveTarget(req, res);
      if (req.method === "PATCH") return routes.handleUpdateTarget(req, res);
      if (req.method === "DELETE") return routes.handleDeleteTarget(url, res);
    }

    if (url.pathname === "/api/history") return routes.handleHistory(url, res);
    if (url.pathname === "/api/status") return sendJson(res, routes.statusPayload());
    if (url.pathname === "/api/live") return live.handleLive(req, res, url);
    if (url.pathname.startsWith("/device-proxy")) return routes.proxyRequest(req, res, url);
    if (url.pathname.startsWith("/device")) return routes.proxyCurrentTarget(req, res, url);
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
  return store.loadConfig(showAppearanceSwitcher);
}

async function refreshConfig() {
  config = await loadConfig();
  return config;
}

async function fetchMachineInfo(target) {
  const html = await fetchText(new URL("/", normalizeTarget(target)).toString(), deviceIdentityTimeoutMs);
  const match = html.match(/window\.__INFOZ=(\{.*?\});/);
  if (!match) throw new Error("window.__INFOZ not found");
  return JSON.parse(match[1]);
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
    const response = await fetchTarget(url, { cache: "no-store", signal: controller.signal });
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
    const response = await fetchTarget(url, { cache: "no-store", signal: controller.signal });
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
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  }[ext] ?? "application/octet-stream";
}
