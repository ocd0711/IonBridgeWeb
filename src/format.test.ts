import { describe, expect, it } from "vitest";

import { PORT_IDLE_WATTS, formatDuration, formatResetReason, isPortOff, portRuntimeState } from "./format";
import type { PortMetrics } from "./types";

const port = (overrides: Partial<PortMetrics>): PortMetrics => ({
  id: 1,
  active: true,
  state: "ACTIVE",
  port_type: "C",
  attached: false,
  charging_duration_seconds: 0,
  fc_protocol: 0,
  current: 0,
  voltage: 0,
  vin_value: 0,
  session_id: 0,
  session_charge: 0,
  power_budget: 140,
  pd_status: null,
  ...overrides,
});

describe("formatDuration", () => {
  it("uses minutes, hours, days, fixed 30-day months, and fixed 365-day years", () => {
    expect(formatDuration(59 * 60)).toBe("59m");
    expect(formatDuration((2 * 60 + 5) * 60)).toBe("2h 5m");
    expect(formatDuration((3 * 24 + 4) * 60 * 60)).toBe("3d 4h");
    expect(formatDuration((2 * 30 + 6) * 24 * 60 * 60)).toBe("2mo 6d");
    expect(formatDuration((365 + 61) * 24 * 60 * 60)).toBe("1y 2mo");
  });
});

describe("formatResetReason", () => {
  it("maps ESP-IDF reset reason values", () => {
    expect(formatResetReason(1, "zh")).toBe("ESP_RST_POWERON · 上电复位");
    expect(formatResetReason(9, "zh")).toBe("ESP_RST_BROWNOUT · 欠压复位");
    expect(formatResetReason(15, "en")).toBe("ESP_RST_CPU_LOCKUP · CPU lockup reset");
  });

  it("keeps unknown reset values visible", () => {
    expect(formatResetReason(99, "zh")).toBe("ESP_RST_99 · 未识别复位原因");
  });
});

describe("portRuntimeState", () => {
  it("treats firmware INACTIVE state as off", () => {
    expect(isPortOff(port({ state: "INACTIVE", active: true }))).toBe(true);
    expect(portRuntimeState(port({ state: "INACTIVE", active: true }))).toBe("off");
  });

  it("does not treat active=false as off when firmware state is available", () => {
    expect(isPortOff(port({ state: "ACTIVE", active: false }))).toBe(false);
    expect(portRuntimeState(port({ state: "ACTIVE", active: false, attached: false }))).toBe("ready");
  });

  it("keeps active=false as a fallback when older metrics have no state", () => {
    expect(isPortOff(port({ state: "", active: false }))).toBe(true);
    expect(portRuntimeState(port({ state: "", active: false }))).toBe("off");
  });

  it("separates attached no-power from attached output", () => {
    expect(portRuntimeState(port({ state: "ATTACHED", attached: true, voltage: 1000, current: PORT_IDLE_WATTS * 1000 - 1 }))).toBe("no-power");
    expect(portRuntimeState(port({ state: "ATTACHED", attached: true, voltage: 1000, current: PORT_IDLE_WATTS * 1000 }))).toBe("attached");
  });

  it("maps firmware transition and abnormal states explicitly", () => {
    expect(portRuntimeState(port({ state: "OPENING" }))).toBe("switching");
    expect(portRuntimeState(port({ state: "CLOSING" }))).toBe("switching");
    expect(portRuntimeState(port({ state: "OVER_TEMP_ALERT" }))).toBe("protecting");
    expect(portRuntimeState(port({ state: "LIMITED_POWER" }))).toBe("protecting");
    expect(portRuntimeState(port({ state: "RECOVERING" }))).toBe("recovering");
    expect(portRuntimeState(port({ state: "CHECKING" }))).toBe("recovering");
    expect(portRuntimeState(port({ state: "DEAD" }))).toBe("fault");
  });
});
