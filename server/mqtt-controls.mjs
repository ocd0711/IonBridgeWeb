export const MqttControlActions = Object.freeze({
  DEVICE_POWER: "devicePower",
  REBOOT_DEVICE: "rebootDevice",
  TELEMETRY_STREAM: "telemetryStream",
  PORT_POWER: "portPower",
  CHARGING_STRATEGY: "chargingStrategy",
  TEMPERATURE_MODE: "temperatureMode",
  TEMPORARY_ALLOCATION: "temporaryAllocation",
  PORT_COMPATIBILITY: "portCompatibility",
  PORT_CONFIG: "portConfig",
  PORT_TYPE: "portType",
  CUSTOM_PDO_VOLTAGE: "customPdoVoltage",
  CABLE_COMPENSATION: "cableCompensation",
  DISPLAY_INTENSITY: "displayIntensity",
  DISPLAY_MODE: "displayMode",
  DISPLAY_SETUP: "displaySetup",
});

export const ServiceCommand = Object.freeze({
  REBOOT_DEVICE: 0x11,
  SET_DEVICE_POWER_STATE: 0x1a,
  SET_CHARGING_STRATEGY: 0x43,
  GET_CHARGING_STRATEGY: 0x48,
  TURN_ON_PORT: 0x4c,
  TURN_OFF_PORT: 0x4d,
  SET_PORT_CONFIG: 0x5d,
  GET_PORT_CONFIG: 0x5e,
  SET_PORT_TYPE: 0x60,
  SET_PORT_COMPATIBILITY_SETTINGS: 0x59,
  GET_PORT_COMPATIBILITY_SETTINGS: 0x5a,
  SET_TEMPERATURE_MODE: 0x5b,
  SET_TEMPORARY_ALLOCATOR: 0x5c,
  SET_CUSTOM_PDO_VOLTAGE: 0x61,
  SET_CABLE_COMPENSATION: 0x62,
  GET_CABLE_COMPENSATION: 0x63,
  SET_DISPLAY_INTENSITY: 0x70,
  SET_DISPLAY_MODE: 0x71,
  GET_DISPLAY_INTENSITY: 0x72,
  GET_DISPLAY_MODE: 0x73,
  GET_DISPLAY_ROTATION: 0x79,
  SET_DISPLAY_SETUP: 0x7d,
  GET_DISPLAY_SETUP: 0x7e,
  START_TELEMETRY_STREAM: 0x90,
  STOP_TELEMETRY_STREAM: 0x91,
  GET_DEVICE_INFO: 0x92,
  STREAM_PORT_STATUS: 0x80,
  STREAM_DEVICE_STATUS: 0x81,
  STREAM_PORT_PD_STATUS: 0x82,
});

const VALID_STRATEGIES = new Set([1, 6, 7, 8]);
const VALID_TEMPERATURE_MODES = new Set([0, 1]);
const VALID_DISPLAY_MODES = new Set([0, 1, 2]);
const VALID_ROTATIONS = new Set([0, 1, 2, 3]);
const VALID_IDLE_ANIMATIONS = new Set([0, 1, 2]);
const VALID_RESISTANCE = new Set([0, 1]);
const VALID_OFFSET = new Set([0, 1, 2, 3]);
const STANDARD_PDO_VOLTAGES = new Set([5000, 9000, 15000, 20000]);

export function buildMqttControlCommand(action, params = {}) {
  switch (action) {
    case MqttControlActions.DEVICE_POWER:
      return {
        command: ServiceCommand.SET_DEVICE_POWER_STATE,
        payload: { setPowerState: { state: boolParam(params.enabled, "enabled") ? 1 : 0 } },
      };
    case MqttControlActions.REBOOT_DEVICE:
      return {
        command: ServiceCommand.REBOOT_DEVICE,
        payload: { rebootDevice: {} },
      };
    case MqttControlActions.TELEMETRY_STREAM:
      return boolParam(params.enabled, "enabled")
        ? { command: ServiceCommand.START_TELEMETRY_STREAM, payload: { startTelemetryStream: {} } }
        : { command: ServiceCommand.STOP_TELEMETRY_STREAM, payload: { stopTelemetryStream: {} } };
    case MqttControlActions.PORT_POWER: {
      const port = portParam(params.port);
      const enabled = boolParam(params.enabled, "enabled");
      return enabled
        ? { command: ServiceCommand.TURN_ON_PORT, payload: { turnOnPort: { ports: [port] } } }
        : { command: ServiceCommand.TURN_OFF_PORT, payload: { turnOffPort: { ports: [port] } } };
    }
    case MqttControlActions.CHARGING_STRATEGY: {
      const strategy = enumParam(params.strategy, VALID_STRATEGIES, "strategy");
      return {
        command: ServiceCommand.SET_CHARGING_STRATEGY,
        payload: { setChargingStrategy: { chargingStrategy: strategy } },
      };
    }
    case MqttControlActions.TEMPERATURE_MODE: {
      const mode = enumParam(params.mode, VALID_TEMPERATURE_MODES, "mode");
      return {
        command: ServiceCommand.SET_TEMPERATURE_MODE,
        payload: { setTemperatureMode: { mode } },
      };
    }
    case MqttControlActions.TEMPORARY_ALLOCATION: {
      const allocation = arrayParam(params.powerAllocation, "powerAllocation", 8)
        .map((value) => intRange(value, 0, 224, "powerAllocation"));
      return {
        command: ServiceCommand.SET_TEMPORARY_ALLOCATOR,
        payload: { setTemporaryAllocator: { powerAllocation: padAllocation(allocation) } },
      };
    }
    case MqttControlActions.PORT_COMPATIBILITY:
      return {
        command: ServiceCommand.SET_PORT_COMPATIBILITY_SETTINGS,
        payload: {
          setPortCompatibilitySettings: {
            settings: {
              enableTfcp: boolParam(params.enableTfcp, "enableTfcp"),
              enableFcp: boolParam(params.enableFcp, "enableFcp"),
              enableUfcs: boolParam(params.enableUfcs, "enableUfcs"),
              enableHvScp: boolParam(params.enableHvScp, "enableHvScp"),
              enableLvScp: boolParam(params.enableLvScp, "enableLvScp"),
            },
          },
        },
      };
    case MqttControlActions.PORT_CONFIG:
      return {
        command: ServiceCommand.SET_PORT_CONFIG,
        payload: {
          setPortConfig: {
            ports: intRange(params.portMask, 1, 0xff, "portMask"),
            configs: padPortConfigs(arrayParam(params.configs, "configs", 8)),
          },
        },
      };
    case MqttControlActions.PORT_TYPE:
      return {
        command: ServiceCommand.SET_PORT_TYPE,
        payload: {
          setPortType: {
            port: portParam(params.port),
            portType: enumParam(params.portType, new Set([0, 1]), "portType"),
          },
        },
      };
    case MqttControlActions.CUSTOM_PDO_VOLTAGE:
      return {
        command: ServiceCommand.SET_CUSTOM_PDO_VOLTAGE,
        payload: {
          setCustomPdoVoltage: {
            port: portParam(params.port),
            voltageMv: customPdoVoltage(params.voltageMv),
          },
        },
      };
    case MqttControlActions.CABLE_COMPENSATION:
      return {
        command: ServiceCommand.SET_CABLE_COMPENSATION,
        payload: {
          setCableCompensation: {
            portMask: intRange(params.portMask, 1, 0xff, "portMask"),
            disable: boolParam(params.disable, "disable"),
            resistance: enumParam(params.resistance, VALID_RESISTANCE, "resistance"),
            voltageOffset: enumParam(params.voltageOffset, VALID_OFFSET, "voltageOffset"),
          },
        },
      };
    case MqttControlActions.DISPLAY_INTENSITY:
      return {
        command: ServiceCommand.SET_DISPLAY_INTENSITY,
        payload: { setDisplayIntensity: { intensity: intRange(params.intensity, 0, 100, "intensity") } },
      };
    case MqttControlActions.DISPLAY_MODE:
      return {
        command: ServiceCommand.SET_DISPLAY_MODE,
        payload: { setDisplayMode: { mode: enumParam(params.mode, VALID_DISPLAY_MODES, "mode") } },
      };
    case MqttControlActions.DISPLAY_SETUP:
      return {
        command: ServiceCommand.SET_DISPLAY_SETUP,
        payload: {
          setDisplaySetup: {
            setup: {
              intensity: intRange(params.intensity, 0, 100, "intensity"),
              rotation: enumParam(params.rotation, VALID_ROTATIONS, "rotation"),
              idleAnimation: enumParam(params.idleAnimation, VALID_IDLE_ANIMATIONS, "idleAnimation"),
            },
          },
        },
      };
    default:
      throw new Error("unsupported MQTT control action");
  }
}

function portParam(value) {
  return intRange(value, 0, 7, "port");
}

function boolParam(value, name) {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function enumParam(value, allowed, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || !allowed.has(number)) {
    throw new Error(`${name} is out of range`);
  }
  return number;
}

function intRange(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} is out of range`);
  }
  return number;
}

function customPdoVoltage(value) {
  const voltage = intRange(value, 5000, 20000, "voltageMv");
  if (STANDARD_PDO_VOLTAGES.has(voltage)) {
    throw new Error("voltageMv must be a custom PD voltage, not 5000/9000/15000/20000");
  }
  return voltage;
}

function padPortConfigs(configs) {
  return Array.from({ length: 8 }, (_, index) => {
    const config = configs[index] ?? {};
    return {
      version: intRange(config.version ?? 2, 0, 255, "version"),
      features: normalizePowerFeatures(config.features ?? {}),
    };
  });
}

function normalizePowerFeatures(features) {
  const keys = [
    "enableTfcp",
    "enablePe",
    "enableQc2p0",
    "enableQc3p0",
    "enableQc3plus",
    "enableAfc",
    "enableFcp",
    "enableHvScp",
    "enableLvScp",
    "enableSfcp",
    "enableApple",
    "enableSamsung",
    "enableUfcs",
    "enablePd",
    "enablePdCompatMode",
    "limitedCurrentMode",
    "enablePdLvpps",
    "enablePdEpr",
    "enablePdRpi",
    "enablePdHvpps",
    "enablePdHardResetOnRefusal",
    "enablePdSprAvs",
  ];
  return Object.fromEntries(keys.map((key) => [key, boolParam(features[key], key)]));
}

function arrayParam(value, name, maxLength) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty array`);
  }
  return value;
}

function padAllocation(allocation) {
  return Array.from({ length: 8 }, (_, index) => allocation[index] ?? 0);
}
