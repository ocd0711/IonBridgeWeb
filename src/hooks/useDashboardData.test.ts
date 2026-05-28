import { describe, expect, it } from "vitest";

import { shouldHoldOfflineStatus } from "./useDashboardData";

describe("live status handling", () => {
  it("holds offline status while a recent SSE snapshot is still fresh", () => {
    expect(shouldHoldOfflineStatus(1000, 2000, 1000)).toBe(true);
  });

  it("allows offline status after the snapshot freshness window expires", () => {
    expect(shouldHoldOfflineStatus(1000, 4000, 1000)).toBe(false);
  });

  it("allows offline status when no snapshot has been received", () => {
    expect(shouldHoldOfflineStatus(0, 2000, 1000)).toBe(false);
  });
});
