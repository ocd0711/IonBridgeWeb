import { describe, expect, it } from "vitest";

import { downsampleChartRows } from "./chartControls";

describe("downsampleChartRows", () => {
  it("keeps chart render data bounded while preserving extrema", () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      time: String(index),
      power: index === 4321 ? 999 : index % 50,
    }));

    const result = downsampleChartRows(rows, ["power"], 400);

    expect(result.length).toBeLessThanOrEqual(400);
    expect(result[0]).toBe(rows[0]);
    expect(result.at(-1)).toBe(rows.at(-1));
    expect(result.some((row) => row.power === 999)).toBe(true);
  });
});
