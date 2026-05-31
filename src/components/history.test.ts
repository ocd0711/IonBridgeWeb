import { describe, expect, it } from "vitest";

import { buildLiveChartRows, buildServerHistoryChartRows } from "./history";
import type { ServerHistoryRow } from "../api";
import type { PortHistory } from "../types";

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

describe("live chart rows", () => {
  it("keeps short temperature gaps caused by timestamp-mismatched samples continuous", () => {
    const history: PortHistory = {
      sample_period_ms: 10_000,
      ports: [{
        port: 1,
        samples: [
          { ts: 10_000, voltage: 20_000, current: 2_000_000, temperature_c: 72 },
          { ts: 12_000, voltage: 20_000, current: 2_100_000 },
          { ts: 16_000, voltage: 20_000, current: 2_200_000 },
        ],
      }],
    };

    const rows = buildLiveChartRows(history);

    expect(rows.map((sample) => sample.temperature)).toEqual([72, 72]);
  });
});
