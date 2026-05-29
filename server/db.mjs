import { DatabaseSync } from "node:sqlite";

import { normalizeTarget } from "./target-security.mjs";

export function createStore({ databasePath, defaultIntervalMs, retentionDays }) {
  const db = openDatabase(databasePath);
  let lastPruneAt = 0;

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
        device_key deviceKey, note, last_status lastStatus, last_error lastError,
        last_seen lastSeen, last_sample_at lastSampleAt
      FROM targets
      ORDER BY updated_at DESC, created_at DESC
    `).all().map((target) => ({
      ...target,
      refreshIntervalMs: clampInterval(Number(target.refreshIntervalMs), defaultIntervalMs),
    }));
  }

  function loadConfig(showAppearanceSwitcher) {
    const targets = listTargets();
    const active = getSetting("active_device_key", targets[0]?.deviceKey ?? "");
    const activeEntry = targets.find((target) => target.deviceKey === active) ?? targets[0] ?? null;
    if ((activeEntry?.deviceKey ?? "") !== active) setSetting("active_device_key", activeEntry?.deviceKey ?? "");
    return {
      targetUrl: activeEntry?.targetUrl ?? "",
      refreshIntervalMs: activeEntry?.refreshIntervalMs ?? defaultIntervalMs,
      showAppearanceSwitcher,
      targets,
    };
  }

  function upsertVerifiedTarget({ deviceKey, targetUrl, refreshIntervalMs, note = null, active, status = "online", error = null }) {
    const normalizedTarget = normalizeTarget(targetUrl);
    if (!normalizedTarget) throw new Error("targetUrl is required");
    const normalizedDeviceKey = normalizeDeviceKey(deviceKey);
    if (!normalizedDeviceKey) throw new Error("PSN is required");
    const now = Date.now();
    db.prepare("DELETE FROM targets WHERE target_url = ? AND device_key != ?").run(normalizedTarget, normalizedDeviceKey);
    db.prepare(`
      INSERT INTO targets (
        device_key, target_url, note, refresh_interval_ms, last_status, last_error,
        last_seen, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_key) DO UPDATE SET
        target_url = excluded.target_url,
        note = COALESCE(excluded.note, targets.note),
        refresh_interval_ms = excluded.refresh_interval_ms,
        last_status = excluded.last_status,
        last_error = excluded.last_error,
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at
    `).run(
      normalizedDeviceKey,
      normalizedTarget,
      note == null ? "" : normalizeTargetNote(note),
      clampInterval(Number(refreshIntervalMs ?? defaultIntervalMs), defaultIntervalMs),
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
        device_key, target, ts, port, voltage, current, temperature_c, power_w, active, attached, state, protocol
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
          row.active,
          row.attached,
          row.state,
          row.protocol,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function pruneHistory(now, force = false) {
    if (!force && now - lastPruneAt < 60 * 60 * 1000) return;
    lastPruneAt = now;
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    db.prepare("DELETE FROM samples WHERE ts < ?").run(cutoff);
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

  function queryHistory({ deviceKey, start, end, portFilter }) {
    if (!deviceKey) return [];
    const sql = portFilter
      ? `SELECT ts, target, port, voltage, current, temperature_c, power_w, active, attached, state, protocol
         FROM samples
         WHERE device_key = ? AND port = ? AND ts >= ? AND ts <= ?
         ORDER BY ts ASC`
      : `SELECT ts, target, port, voltage, current, temperature_c, power_w, active, attached, state, protocol
         FROM samples
         WHERE device_key = ? AND ts >= ? AND ts <= ?
         ORDER BY ts ASC`;
    const rows = portFilter
      ? db.prepare(sql).all(deviceKey, Number(portFilter), start, end)
      : db.prepare(sql).all(deviceKey, start, end);
    return rows.map((row) => ({ ...row, active: Boolean(row.active), attached: Boolean(row.attached) }));
  }

  function sampleCounts() {
    return new Map(db.prepare(`
      SELECT device_key deviceKey, COUNT(*) count, MAX(ts) lastSampleAt
      FROM samples
      GROUP BY device_key
    `).all().map((row) => [row.deviceKey, row]));
  }

  function savedTargetDeviceKey(targetUrl) {
    return db.prepare("SELECT device_key FROM targets WHERE target_url = ?").get(normalizeTarget(targetUrl))?.device_key ?? null;
  }

  function savedProxyTarget({ deviceKey, targetUrl }) {
    const normalizedDeviceKey = normalizeDeviceKey(deviceKey);
    if (normalizedDeviceKey) {
      return db.prepare("SELECT target_url FROM targets WHERE device_key = ?").get(normalizedDeviceKey)?.target_url ?? null;
    }
    const normalizedTarget = normalizeTarget(targetUrl);
    if (!normalizedTarget) return null;
    return db.prepare("SELECT target_url FROM targets WHERE target_url = ?").get(normalizedTarget)?.target_url ?? null;
  }

  function updateTargetNote({ deviceKey, targetUrl, note }) {
    const normalizedDeviceKey = normalizeDeviceKey(deviceKey);
    const normalizedTarget = normalizeTarget(targetUrl);
    const normalizedNote = normalizeTargetNote(note);
    const now = Date.now();
    const result = normalizedDeviceKey
      ? db.prepare("UPDATE targets SET note = ?, updated_at = ? WHERE device_key = ?").run(normalizedNote, now, normalizedDeviceKey)
      : db.prepare("UPDATE targets SET note = ?, updated_at = ? WHERE target_url = ?").run(normalizedNote, now, normalizedTarget);
    return result.changes;
  }

  function deleteTargetAndSamples(targetUrl) {
    const normalizedTarget = normalizeTarget(targetUrl);
    const { deviceKey } = resolveHistoryKey(normalizedTarget);
    if (deviceKey) {
      db.prepare("DELETE FROM targets WHERE device_key = ?").run(deviceKey);
      db.prepare("DELETE FROM samples WHERE device_key = ?").run(deviceKey);
    } else {
      db.prepare("DELETE FROM targets WHERE target_url = ?").run(normalizedTarget);
    }
    if (getSetting("active_device_key", "") === deviceKey) {
      const nextTarget = listTargets()[0]?.deviceKey ?? "";
      setSetting("active_device_key", nextTarget);
    }
    return { deviceKey, targetUrl: normalizedTarget };
  }

  return {
    getSetting,
    setSetting,
    listTargets,
    loadConfig,
    upsertVerifiedTarget,
    markTargetStatus,
    markTargetStatusByTarget,
    insertSamples,
    pruneHistory,
    resolveHistoryKey,
    getTargetByHistoryKey,
    queryHistory,
    sampleCounts,
    savedTargetDeviceKey,
    savedProxyTarget,
    updateTargetNote,
    deleteTargetAndSamples,
  };
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
      active INTEGER,
      attached INTEGER,
      state TEXT,
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
        active INTEGER DEFAULT 0,
        attached INTEGER,
        state TEXT DEFAULT '',
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
  addColumnIfMissing(database, "samples", "active INTEGER");
  addColumnIfMissing(database, "samples", "state TEXT");
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
      note TEXT NOT NULL DEFAULT '',
      refresh_interval_ms INTEGER NOT NULL DEFAULT 30000,
      last_status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT,
      last_seen INTEGER,
      last_sample_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  if (!tableHasRequiredColumns(database, "targets", ["note"])) {
    database.exec("ALTER TABLE targets ADD COLUMN note TEXT NOT NULL DEFAULT ''");
  }
  if (!targetsSchemaIsCurrent(database)) {
    database.exec(`
      DROP TABLE IF EXISTS targets_v2;
      CREATE TABLE targets_v2 (
        device_key TEXT PRIMARY KEY,
        target_url TEXT NOT NULL UNIQUE,
        note TEXT NOT NULL DEFAULT '',
        refresh_interval_ms INTEGER NOT NULL DEFAULT 30000,
        last_status TEXT NOT NULL DEFAULT 'unknown',
        last_error TEXT,
        last_seen INTEGER,
        last_sample_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR REPLACE INTO targets_v2 (
        device_key, target_url, note, refresh_interval_ms, last_status, last_error,
        last_seen, last_sample_at, created_at, updated_at
      )
      SELECT device_key, target_url, COALESCE(note, ''), refresh_interval_ms,
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

function addColumnIfMissing(database, table, definition) {
  const columnName = definition.trim().split(/\s+/, 1)[0];
  if (!tableHasRequiredColumns(database, table, [columnName])) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
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
    names.has("note") &&
    names.has("refresh_interval_ms") &&
    names.has("last_status") &&
    !names.has("label") &&
    !names.has("enabled") &&
    Boolean(deviceKey?.pk)
  );
}

export function normalizeDeviceKey(value) {
  const key = String(value ?? "").trim();
  if (!key || key.toLowerCase() === "unknown") return null;
  return key;
}

export function normalizeTargetNote(value) {
  return String(value ?? "").trim().slice(0, 80);
}

export function requireDeviceKey(machineInfo) {
  const deviceKey = normalizeDeviceKey(machineInfo?.psn);
  if (!deviceKey) throw new Error("target did not expose a valid PSN");
  return deviceKey;
}

export function clampInterval(value, defaultIntervalMs = 30000) {
  return Math.max(1000, Math.min(60000, Math.round(Number.isFinite(value) ? value : defaultIntervalMs)));
}
