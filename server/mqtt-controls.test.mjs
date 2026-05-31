import { describe, expect, it } from "vitest";

import { buildMqttControlCommand, ServiceCommand } from "./mqtt-controls.mjs";

describe("mqtt control command builder", () => {
  it("builds safe port power commands", () => {
    expect(buildMqttControlCommand("portPower", { port: 4, enabled: false })).toEqual({
      command: ServiceCommand.TURN_OFF_PORT,
      payload: { turnOffPort: { ports: [4] } },
    });
    expect(buildMqttControlCommand("portPower", { port: 1, enabled: true })).toEqual({
      command: ServiceCommand.TURN_ON_PORT,
      payload: { turnOnPort: { ports: [1] } },
    });
  });

  it("rejects unsupported command parameters", () => {
    expect(() => buildMqttControlCommand("portPower", { port: 99, enabled: true })).toThrow("port is out of range");
    expect(() => buildMqttControlCommand("chargingStrategy", { strategy: 0 })).toThrow("strategy is out of range");
    expect(() => buildMqttControlCommand("chargingStrategy", { strategy: 3 })).toThrow("strategy is out of range");
    expect(() => buildMqttControlCommand("displaySetup", { intensity: 101, rotation: 0, idleAnimation: 0 })).toThrow("intensity is out of range");
    expect(() => buildMqttControlCommand("customPdoVoltage", { port: 1, voltageMv: 48000 })).toThrow("voltageMv is out of range");
    expect(() => buildMqttControlCommand("customPdoVoltage", { port: 1, voltageMv: 9000 })).toThrow("voltageMv must be a custom PD voltage");
  });

  it("uses firmware strategy ids and pads temporary allocation by port id", () => {
    expect(buildMqttControlCommand("chargingStrategy", { strategy: 6 })).toEqual({
      command: ServiceCommand.SET_CHARGING_STRATEGY,
      payload: { setChargingStrategy: { chargingStrategy: 6 } },
    });
    expect(buildMqttControlCommand("temporaryAllocation", { powerAllocation: [60, 30, 30, 40, 0] })).toEqual({
      command: ServiceCommand.SET_TEMPORARY_ALLOCATOR,
      payload: { setTemporaryAllocator: { powerAllocation: [60, 30, 30, 40, 0, 0, 0, 0] } },
    });
  });

  it("builds display setup with firmware enum values", () => {
    expect(buildMqttControlCommand("displaySetup", { intensity: 60, rotation: 2, idleAnimation: 2 })).toEqual({
      command: ServiceCommand.SET_DISPLAY_SETUP,
      payload: {
        setDisplaySetup: {
          setup: {
            intensity: 60,
            rotation: 2,
            idleAnimation: 2,
          },
        },
      },
    });
  });

  it("builds custom PD voltage commands with millivolt values", () => {
    expect(buildMqttControlCommand("customPdoVoltage", { port: 1, voltageMv: 11000 })).toEqual({
      command: ServiceCommand.SET_CUSTOM_PDO_VOLTAGE,
      payload: { setCustomPdoVoltage: { port: 1, voltageMv: 11000 } },
    });
  });

  it("builds C4 appliance mode commands with firmware port type values", () => {
    expect(buildMqttControlCommand("portType", { port: 4, portType: 0 })).toEqual({
      command: ServiceCommand.SET_PORT_TYPE,
      payload: { setPortType: { port: 4, portType: 0 } },
    });
    expect(buildMqttControlCommand("portType", { port: 4, portType: 1 })).toEqual({
      command: ServiceCommand.SET_PORT_TYPE,
      payload: { setPortType: { port: 4, portType: 1 } },
    });
    expect(() => buildMqttControlCommand("portType", { port: 4, portType: 2 })).toThrow("portType is out of range");
  });

  it("exposes firmware get commands used for state sync", () => {
    expect(ServiceCommand.GET_CHARGING_STRATEGY).toBe(0x48);
    expect(ServiceCommand.GET_PORT_COMPATIBILITY_SETTINGS).toBe(0x5a);
    expect(ServiceCommand.GET_CABLE_COMPENSATION).toBe(0x63);
    expect(ServiceCommand.GET_DISPLAY_INTENSITY).toBe(0x72);
    expect(ServiceCommand.GET_DISPLAY_MODE).toBe(0x73);
    expect(ServiceCommand.GET_DISPLAY_ROTATION).toBe(0x79);
    expect(ServiceCommand.GET_DISPLAY_SETUP).toBe(0x7e);
  });
});
