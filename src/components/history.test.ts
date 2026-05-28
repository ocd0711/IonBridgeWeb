import { describe, expect, it } from "vitest";

import { buildServerHistoryChartRows } from "./history";
import type { ServerHistoryRow } from "../api";

function row(ts: number, power_w: number): ServerHistoryRow {
  return {
    ts,
    target: "http://device.local",
    port: 1,
    voltage: 9000,
    current: 1000000,
    temperature_c: 40,
    power_w,
    attached: true,
    protocol: "PD",
  };
}

describe("server history chart rows", () => {
  it("inserts null gap markers across missing collection windows", () => {
    const rows = buildServerHistoryChartRows([
      row(0, 9),
      row(60_000, 10),
      row(30 * 60_000, 11),
    ]);

    expect(rows.some((sample) => sample.power == null && sample.temperature == null)).toBe(true);
  });
});
