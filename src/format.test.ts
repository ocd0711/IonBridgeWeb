import { describe, expect, it } from "vitest";

import { formatDuration } from "./format";

describe("formatDuration", () => {
  it("uses minutes, hours, days, fixed 30-day months, and fixed 365-day years", () => {
    expect(formatDuration(59 * 60)).toBe("59m");
    expect(formatDuration((2 * 60 + 5) * 60)).toBe("2h 5m");
    expect(formatDuration((3 * 24 + 4) * 60 * 60)).toBe("3d 4h");
    expect(formatDuration((2 * 30 + 6) * 24 * 60 * 60)).toBe("2mo 6d");
    expect(formatDuration((365 + 61) * 24 * 60 * 60)).toBe("1y 2mo");
  });
});
