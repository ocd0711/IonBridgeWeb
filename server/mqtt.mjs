import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import mqtt from "mqtt";
import protobuf from "protobufjs";

import { buildMqttControlCommand, ServiceCommand } from "./mqtt-controls.mjs";

const protoDir = join(dirname(fileURLToPath(import.meta.url)), "proto");
const TelemetryCommand = {
  DEVICE_BOOT_INFO: 0x10,
  DEVICE_STATS_DATA: 0x11,
};

export function createMqttBridge({ store, refreshConfig, broadcast }) {
  const codec = loadCodec();
  const deviceState = new Map();
  let client = null;
  let connection = {
    enabled: false,
    configured: false,
    brokerUrl: "",
    connected: false,
    lastError: null,
    lastMessageAt: null,
  };
  let requestId = 1;
  const pendingRequests = new Map();
  const lastTelemetryRequestAt = new Map();
  const lastPortSnapshotAt = new Map();
  let telemetryKickTimer = null;

  function start() {
    reconnect();
  }

  function reconnect() {
    const config = store.getMqttConnectionOptions();
    const shouldConnect = Boolean(config.brokerUrl);
    closeClient();
    connection = {
      enabled: shouldConnect,
      configured: config.configured,
      brokerUrl: config.brokerUrl,
      connected: false,
      lastError: null,
      lastMessageAt: connection.lastMessageAt,
    };
    if (!shouldConnect) return;

    client = mqtt.connect(config.brokerUrl, {
      username: config.username || undefined,
      password: config.password || undefined,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
      clean: true,
      clientId: `ionbridge-web-${Math.random().toString(16).slice(2)}`,
    });
    client.on("connect", () => {
      connection = { ...connection, connected: true, lastError: null };
      client?.subscribe(["device/+/telemetry/+", "device/+/enduser/response/+"], { qos: 0 });
      requestTelemetryForSavedTargets({ includeDeviceInfo: true, force: true });
      startTelemetryKickTimer();
    });
    client.on("message", (topic, payload) => {
      connection = { ...connection, lastError: null, lastMessageAt: Date.now() };
      handleMessage(topic, payload);
    });
    client.on("error", (error) => {
      connection = { ...connection, connected: false, lastError: error.message };
    });
    client.on("close", () => {
      connection = { ...connection, connected: false };
      rejectPending("MQTT broker disconnected");
      stopTelemetryKickTimer();
    });
  }

  function closeClient() {
    stopTelemetryKickTimer();
    if (!client) return;
    rejectPending("MQTT broker disconnected");
    client.removeAllListeners();
    client.end(true);
    client = null;
  }

  function status() {
    return { ...connection };
  }

  function publishCommand(deviceKey, command, payload) {
    if (!client?.connected) throw new Error("MQTT broker is not connected");
    const normalizedDeviceKey = String(deviceKey ?? "").trim();
    if (!normalizedDeviceKey) throw new Error("deviceKey is required");
    const id = nextRequestId();
    const message = codec.CommandRequest.create({
      id,
      ...payload,
    });
    const body = codec.CommandRequest.encode(message).finish();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error("MQTT command timed out"));
      }, 8000);
      pendingRequests.set(id, { command, resolve, reject, timeout });
      client.publish(`device/${normalizedDeviceKey}/enduser/request/${command}`, body, { qos: 0 }, (error) => {
        if (!error) return;
        const pending = pendingRequests.get(id);
        if (!pending) return;
        pendingRequests.delete(id);
        clearTimeout(pending.timeout);
        reject(error);
      });
    });
  }

  function setPortPower(deviceKey, port, enabled) {
    return sendControl(deviceKey, "portPower", { port, enabled });
  }

  function setTelemetryStream(deviceKey, enabled) {
    return sendControl(deviceKey, "telemetryStream", { enabled });
  }

  function sendControl(deviceKey, action, params) {
    const { command, payload } = buildMqttControlCommand(action, params);
    return publishCommand(deviceKey, command, payload);
  }

  async function queryControlState(deviceKey, ports = []) {
    const state = {};
    const errors = {};
    const normalizedPorts = [...new Set(ports.map((port) => Number(port)).filter((port) => Number.isInteger(port) && port >= 0 && port <= 7))];

    await Promise.all([
      queryState(deviceKey, "chargingStrategy", ServiceCommand.GET_CHARGING_STRATEGY, { getChargingStrategy: {} }, (payload) => {
        if (payload?.chargingStrategy != null) state.chargingStrategy = Number(payload.chargingStrategy);
      }, errors),
      queryState(deviceKey, "compatibility", ServiceCommand.GET_PORT_COMPATIBILITY_SETTINGS, { getPortCompatibilitySettings: {} }, (payload) => {
        if (payload?.settings) state.compatibility = normalizeCompatibility(payload.settings);
      }, errors),
      queryState(deviceKey, "portConfigs", ServiceCommand.GET_PORT_CONFIG, { getPortConfig: { version: 2 } }, (payload) => {
        if (Array.isArray(payload?.configs)) state.portConfigs = payload.configs.map(normalizePortConfig);
      }, errors),
      queryState(deviceKey, "displayIntensity", ServiceCommand.GET_DISPLAY_INTENSITY, { getDisplayIntensity: {} }, (payload) => {
        if (payload?.intensity != null) state.displayIntensity = Number(payload.intensity);
      }, errors),
      queryState(deviceKey, "displayMode", ServiceCommand.GET_DISPLAY_MODE, { getDisplayMode: {} }, (payload) => {
        if (payload?.mode != null) state.displayMode = Number(payload.mode);
      }, errors),
      queryState(deviceKey, "displayRotation", ServiceCommand.GET_DISPLAY_ROTATION, { getDisplayRotation: {} }, (payload) => {
        if (payload?.rotation != null) state.displayRotation = Number(payload.rotation);
      }, errors),
      queryState(deviceKey, "displaySetup", ServiceCommand.GET_DISPLAY_SETUP, { getDisplaySetup: {} }, (payload) => {
        if (!payload?.setup) return;
        state.displayIntensity = Number(payload.setup.intensity ?? state.displayIntensity ?? 0);
        state.displayRotation = Number(payload.setup.rotation ?? state.displayRotation ?? 0);
        state.idleAnimation = Number(payload.setup.idleAnimation ?? state.idleAnimation ?? 0);
      }, errors),
      ...normalizedPorts.map((port) => queryState(
        deviceKey,
        `cable:${port}`,
        ServiceCommand.GET_CABLE_COMPENSATION,
        { getCableCompensation: { port } },
        (payload) => {
          if (!payload) return;
          state.cableCompensation = {
            ...(state.cableCompensation ?? {}),
            [port]: {
              enable: Boolean(payload.enable),
              resistance: Number(payload.resistance ?? 0),
              voltageOffset: Number(payload.voltageOffset ?? 0),
            },
          };
        },
        errors,
      )),
    ]);

    return { state, errors };
  }

  async function queryState(deviceKey, key, command, payload, apply, errors) {
    try {
      const response = await publishCommand(deviceKey, command, payload);
      apply(response.payload);
    } catch (error) {
      errors[key] = error instanceof Error ? error.message : String(error);
    }
  }

  function requestInitialTelemetry(deviceKey, options = {}) {
    const normalizedDeviceKey = String(deviceKey ?? "").trim();
    if (!normalizedDeviceKey) return;
    const now = Date.now();
    const minIntervalMs = options.force ? 0 : 10000;
    if (now - (lastTelemetryRequestAt.get(normalizedDeviceKey) ?? 0) < minIntervalMs) return;
    lastTelemetryRequestAt.set(normalizedDeviceKey, now);
    if (options.includeDeviceInfo) {
      void publishCommand(normalizedDeviceKey, ServiceCommand.GET_DEVICE_INFO, { getDeviceInfo: {} }).catch(updateBackgroundError);
    }
    void publishCommand(normalizedDeviceKey, ServiceCommand.START_TELEMETRY_STREAM, { startTelemetryStream: {} }).catch(updateBackgroundError);
  }

  function requestTelemetryForSavedTargets(options = {}) {
    for (const target of store.listTargets()) {
      if (!target.deviceKey) continue;
      requestInitialTelemetry(target.deviceKey, options);
    }
  }

  function startTelemetryKickTimer() {
    stopTelemetryKickTimer();
    telemetryKickTimer = setInterval(() => {
      if (!client?.connected) return;
      const now = Date.now();
      for (const target of store.listTargets()) {
        const deviceKey = String(target.deviceKey ?? "").trim();
        if (!deviceKey) continue;
        const lastPortsAt = lastPortSnapshotAt.get(deviceKey) ?? 0;
        if (lastPortsAt && now - lastPortsAt < 10000) continue;
        requestInitialTelemetry(deviceKey);
      }
    }, 5000);
  }

  function stopTelemetryKickTimer() {
    if (!telemetryKickTimer) return;
    clearInterval(telemetryKickTimer);
    telemetryKickTimer = null;
  }

  function handleMessage(topic, payload) {
    const parsed = parseTopic(topic);
    if (!parsed) return;
    try {
      if (parsed.source === "enduser" && parsed.direction === "response") {
        const decoded = codec.CommandResponse.decode(payload);
        handleCommandResponse(parsed.deviceKey, parsed.commandId, decoded);
      }
      if (parsed.source === "telemetry") {
        const decoded = codec.TelemetryData.decode(payload);
        handleTelemetry(parsed.deviceKey, parsed.commandId, decoded);
      }
    } catch (error) {
      connection = {
        ...connection,
        lastError: error instanceof Error ? error.message : "failed to decode MQTT message",
      };
    }
  }

  function handleCommandResponse(deviceKey, commandId, response) {
    settlePending(response, commandId);
    const state = getDeviceState(deviceKey);
    if (commandId === ServiceCommand.GET_DEVICE_INFO && response.getDeviceInfo?.info) {
      state.machineInfo = machineInfoFromDeviceInfo(response.getDeviceInfo.info, deviceKey);
      publishSnapshot(deviceKey);
      return;
    }
    if (commandId === ServiceCommand.STREAM_PORT_STATUS && response.streamPortStatus) {
      state.ports = portsFromStream(response.streamPortStatus);
      lastPortSnapshotAt.set(deviceKey, Date.now());
      persistPorts(deviceKey, state.ports);
      publishSnapshot(deviceKey);
      return;
    }
    if (commandId === ServiceCommand.STREAM_DEVICE_STATUS && response.streamDeviceStatus) {
      state.deviceStatus = response.streamDeviceStatus;
      publishSnapshot(deviceKey);
      return;
    }
    if (commandId === ServiceCommand.STREAM_PORT_PD_STATUS && response.streamPortPdStatus) {
      const pd = response.streamPortPdStatus;
      state.pdStatus.set(Number(pd.port), pd.pdStatus ?? null);
      publishSnapshot(deviceKey);
    }
  }

  function handleTelemetry(deviceKey, commandId, telemetry) {
    const state = getDeviceState(deviceKey);
    if (commandId === TelemetryCommand.DEVICE_BOOT_INFO && telemetry.deviceBootInfo) {
      state.bootInfo = telemetry.deviceBootInfo;
      state.machineInfo = {
        ...state.machineInfo,
        psn: deviceKey,
        device_model: telemetry.deviceBootInfo.deviceModel || state.machineInfo.device_model,
        product_family: telemetry.deviceBootInfo.productFamily || state.machineInfo.product_family,
        hw_rev: telemetry.deviceBootInfo.hardwareRevision || state.machineInfo.hw_rev,
        esp32_version: formatVersion(telemetry.deviceBootInfo.esp32Version) || state.machineInfo.esp32_version,
        mcu_version: formatVersion(telemetry.deviceBootInfo.sw3566Version) || state.machineInfo.mcu_version,
        fpga_version: formatVersion(telemetry.deviceBootInfo.fpgaVersion) || state.machineInfo.fpga_version,
        zrlib_version: formatVersion(telemetry.deviceBootInfo.zrlibVersion) || state.machineInfo.zrlib_version,
      };
      publishSnapshot(deviceKey);
      return;
    }
    if (commandId === TelemetryCommand.DEVICE_STATS_DATA && telemetry.deviceStatsData) {
      state.deviceStats = telemetry.deviceStatsData;
      publishSnapshot(deviceKey);
    }
  }

  function publishSnapshot(deviceKey) {
    const targetUrl = store.savedProxyTarget({ deviceKey });
    if (!targetUrl) return;
    const state = getDeviceState(deviceKey);
    const ts = Date.now();
    const metrics = metricsFromState(state);
    store.markTargetStatus(deviceKey, "online", null, { seenAt: ts });
    refreshConfig().then((config) => {
      broadcast({
        type: "snapshot",
        source: "mqtt",
        deviceKey,
        targetUrl,
        ts,
        metrics,
        heap: null,
        machineInfo: state.machineInfo,
        config,
      });
    }).catch(() => {});
  }

  function persistPorts(deviceKey, ports) {
    const target = store.savedProxyTarget({ deviceKey });
    if (!target || ports.length === 0) return;
    const ts = Date.now();
    store.insertSamples(ports.map((port) => ({
      device_key: deviceKey,
      target,
      ts,
      port: port.id,
      active: port.active ? 1 : 0,
      attached: port.attached ? 1 : 0,
      voltage: port.voltage,
      current: port.current,
      state: port.state,
      temperature_c: validTemperature(port.die_temperature),
      power_w: (port.voltage * port.current) / 1_000_000,
      protocol: port.fc_protocol,
    })));
    store.pruneHistory(ts);
  }

  function getDeviceState(deviceKey) {
    if (!deviceState.has(deviceKey)) {
      deviceState.set(deviceKey, {
        ports: [],
        pdStatus: new Map(),
        machineInfo: emptyMachineInfo(deviceKey),
        bootInfo: null,
        deviceStats: null,
        deviceStatus: null,
      });
    }
    return deviceState.get(deviceKey);
  }

  function nextRequestId() {
    requestId = requestId >= 0xfffffff ? 1 : requestId + 1;
    return requestId;
  }

  function settlePending(response, commandId) {
    const pending = pendingRequests.get(Number(response.id));
    if (!pending) return;
    pendingRequests.delete(Number(response.id));
    clearTimeout(pending.timeout);
    const status = Number(response.status ?? 1);
    if (status === 0) {
      connection = { ...connection, lastError: null };
      pending.resolve({ command: commandId, status, payload: responsePayloadFor(commandId, response) });
      return;
    }
    pending.reject(new Error(`MQTT command failed with status ${status}`));
  }

  function rejectPending(message) {
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      pendingRequests.delete(id);
    }
  }

  function updateLastError(error) {
    connection = {
      ...connection,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }

  function updateBackgroundError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("timed out") && connection.lastMessageAt) return;
    updateLastError(error);
  }

  return {
    start,
    reconnect,
    status,
    setPortPower,
    setTelemetryStream,
    sendControl,
    queryControlState,
  };
}

function responsePayloadFor(commandId, response) {
  switch (Number(commandId)) {
    case ServiceCommand.GET_CHARGING_STRATEGY:
      return response.getChargingStrategy ?? null;
    case ServiceCommand.GET_PORT_COMPATIBILITY_SETTINGS:
      return response.getPortCompatibilitySettings ?? null;
    case ServiceCommand.GET_PORT_CONFIG:
      return response.getPortConfig ?? null;
    case ServiceCommand.GET_CABLE_COMPENSATION:
      return response.getCableCompensation ?? null;
    case ServiceCommand.GET_DISPLAY_INTENSITY:
      return response.getDisplayIntensity ?? null;
    case ServiceCommand.GET_DISPLAY_MODE:
      return response.getDisplayMode ?? null;
    case ServiceCommand.GET_DISPLAY_ROTATION:
      return response.getDisplayRotation ?? null;
    case ServiceCommand.GET_DISPLAY_SETUP:
      return response.getDisplaySetup ?? null;
    default:
      return null;
  }
}

function normalizeCompatibility(settings) {
  return {
    enableTfcp: Boolean(settings.enableTfcp),
    enableFcp: Boolean(settings.enableFcp),
    enableUfcs: Boolean(settings.enableUfcs),
    enableHvScp: Boolean(settings.enableHvScp),
    enableLvScp: Boolean(settings.enableLvScp),
  };
}

function normalizePortConfig(config) {
  return {
    version: Number(config.version ?? 2),
    features: normalizePowerFeatures(config.features ?? {}),
  };
}

function normalizePowerFeatures(features) {
  return {
    enableTfcp: Boolean(features.enableTfcp),
    enablePe: Boolean(features.enablePe),
    enableQc2p0: Boolean(features.enableQc2p0),
    enableQc3p0: Boolean(features.enableQc3p0),
    enableQc3plus: Boolean(features.enableQc3plus),
    enableAfc: Boolean(features.enableAfc),
    enableFcp: Boolean(features.enableFcp),
    enableHvScp: Boolean(features.enableHvScp),
    enableLvScp: Boolean(features.enableLvScp),
    enableSfcp: Boolean(features.enableSfcp),
    enableApple: Boolean(features.enableApple),
    enableSamsung: Boolean(features.enableSamsung),
    enableUfcs: Boolean(features.enableUfcs),
    enablePd: Boolean(features.enablePd),
    enablePdCompatMode: Boolean(features.enablePdCompatMode),
    limitedCurrentMode: Boolean(features.limitedCurrentMode),
    enablePdLvpps: Boolean(features.enablePdLvpps),
    enablePdEpr: Boolean(features.enablePdEpr),
    enablePdRpi: Boolean(features.enablePdRpi),
    enablePdHvpps: Boolean(features.enablePdHvpps),
    enablePdHardResetOnRefusal: Boolean(features.enablePdHardResetOnRefusal),
    enablePdSprAvs: Boolean(features.enablePdSprAvs),
  };
}

function loadCodec() {
  const root = new protobuf.Root();
  root.resolvePath = (origin, target) => join(protoDir, target);
  for (const file of ["data_types.proto", "command.proto", "telemetry.proto", "admin.proto"]) {
    protobuf.parse(readFileSync(join(protoDir, file), "utf8"), root, { keepCase: false });
  }
  root.resolveAll();
  return {
    CommandRequest: root.lookupType("pb.CommandRequest"),
    CommandResponse: root.lookupType("pb.CommandResponse"),
    TelemetryData: root.lookupType("pb.TelemetryData"),
  };
}

function parseTopic(topic) {
  const parts = topic.split("/");
  if (parts[0] !== "device" || parts.length !== 5) return null;
  return {
    deviceKey: parts[1],
    source: parts[2],
    direction: parts[3],
    commandId: Number(parts[4]),
  };
}

function portsFromStream(stream) {
  const portStatusMap = Number(stream.portStatusMap ?? 0);
  return (stream.ports ?? []).map((port, index) => {
    const details = port.details ?? {};
    const active = Boolean((portStatusMap >> index) & 1);
    const attached = Boolean(details.connected);
    return {
      id: index,
      active,
      state: active ? (attached ? "ATTACHED" : "ACTIVE") : "INACTIVE",
      port_type: Number(port.portType) === 0 ? "A" : "C",
      attached,
      charging_duration_seconds: Number(port.chargingMinutes ?? 0) * 60,
      fc_protocol: Number(details.fcProtocol ?? 0),
      current: Number(details.ioutValue ?? 0),
      voltage: Number(details.voutValue ?? 0),
      die_temperature: validTemperature(details.dieTemperature) ?? undefined,
      vin_value: Number(details.vinValue ?? 0),
      session_id: Number(details.sessionId ?? 0),
      session_charge: numberValue(details.sessionCharge),
      power_budget: Number(details.powerBudget ?? 0),
      pd_status: null,
    };
  });
}

function metricsFromState(state) {
  const stats = state.deviceStats ?? {};
  const boot = state.bootInfo ?? {};
  const deviceStatus = state.deviceStatus ?? {};
  const ports = state.ports.map((port) => ({
    ...port,
    pd_status: state.pdStatus.get(port.id) ?? port.pd_status,
  }));
  return {
    ports,
    system: {
      chip: chipName(boot.chipModel),
      cores: Number(boot.chipCores ?? 0),
      cpu_freq_mhz: 0,
      idf_version: formatVersion(boot.espIdfVersion),
      app_version: formatVersion(boot.esp32Version),
      boot_time_seconds: Number(deviceStatus.deviceUptime ?? Math.floor(numberValue(boot.uptime) / 1000)),
      reset_reason: Number(boot.resetReason ?? 0),
      free_heap: Number(stats.freeHeapSize ?? 0),
    },
    tasks: [],
    wifi: {
      ssid: state.machineInfo.ssid || "",
      bssid: state.machineInfo.bssid || "",
      channel: Number(stats.wifiChannel ?? state.machineInfo.channel ?? 0),
      rssi: Number(stats.wifiRssi ?? state.machineInfo.rssi ?? 0),
    },
  };
}

function machineInfoFromDeviceInfo(info, deviceKey) {
  return {
    psn: info.psn || deviceKey,
    ble_mac: stringOrMac(info.bleMac),
    wifi_mac: stringOrMac(info.wifiMac),
    hw_rev: "",
    device_model: info.model || "",
    device_name: info.model || `IonBridge-${deviceKey}`,
    product_family: "",
    product_color: "",
    esp32_version: formatVersion(info.apVersion),
    mcu_version: formatVersion(info.bpVersion),
    fpga_version: formatVersion(info.fpgaVersion),
    zrlib_version: formatVersion(info.zrlibVersion),
    country_code: "",
    mdns_hostname: "",
    bssid: stringOrMac(info.bssid),
    ssid: info.ssid || "",
    rssi: Number(info.rssi ?? 0),
    channel: Number(info.channel ?? 0),
  };
}

function emptyMachineInfo(deviceKey) {
  return {
    psn: deviceKey,
    ble_mac: "",
    wifi_mac: "",
    hw_rev: "",
    device_model: "",
    device_name: `IonBridge-${deviceKey}`,
    product_family: "",
    product_color: "",
    esp32_version: "",
    mcu_version: "",
    fpga_version: "",
    zrlib_version: "",
    country_code: "",
    mdns_hostname: "",
  };
}

function formatVersion(version) {
  if (!version) return "";
  const major = Number(version.major ?? 0);
  const minor = Number(version.minor ?? 0);
  const patch = Number(version.patch ?? 0);
  return [major, minor, patch].join(".");
}

function stringOrMac(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Array.from(value).map((byte) => byte.toString(16).padStart(2, "0")).join(":");
  }
  return String(value);
}

function chipName(value) {
  return value == null ? "" : `chip-${Number(value)}`;
}

function numberValue(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value.toNumber === "function") return value.toNumber();
  return Number(value) || 0;
}

function validTemperature(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
}
