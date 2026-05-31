import { describe, expect, it } from "vitest";

import { isMqttHeartbeatFresh } from "./useDashboardData";

describe("live status handling", () => {
  it("keeps MQTT data authority while recent port telemetry is fresh", () => {
    expect(isMqttHeartbeatFresh(1000, 2500, 1000)).toBe(true);
  });

  it("falls back after two MQTT telemetry intervals without port data", () => {
    expect(isMqttHeartbeatFresh(1000, 8000, 1000)).toBe(false);
  });

  it("falls back when no MQTT port telemetry has been received", () => {
    expect(isMqttHeartbeatFresh(0, 2000, 1000)).toBe(false);
  });
});
