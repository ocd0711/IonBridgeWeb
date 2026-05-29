import { describe, expect, it } from "vitest";

import { formatDuration, formatResetReason } from "./format";

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
