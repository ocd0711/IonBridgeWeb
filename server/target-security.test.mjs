import { describe, expect, it, vi } from "vitest";

import { createTargetFetcher, normalizeTarget, parseAllowedTargetRules } from "./target-security.mjs";

describe("target security", () => {
  it("normalizes bare target hosts", () => {
    expect(normalizeTarget("cp02.local/")).toBe("http://cp02.local");
    expect(normalizeTarget("http://192.168.1.10/")).toBe("http://192.168.1.10");
    expect(normalizeTarget("")).toBe("");
  });

  it("parses CIDR and host allow rules", () => {
    expect(parseAllowedTargetRules("192.168.0.0/16,cp02.local,*.local")).toEqual([
      { type: "cidr4", network: 3232235520, mask: 4294901760 },
      { type: "host", value: "cp02.local" },
      { type: "suffix", value: ".local" },
    ]);
  });

  it("blocks non-http targets before fetch", async () => {
    const fetchTarget = createTargetFetcher({
      allowedTargets: "192.168.0.0/16",
      allowTargetRedirects: false,
      maxTargetRedirects: 0,
    });

    await expect(fetchTarget("https://192.168.1.2")).rejects.toThrow("target protocol is not allowed");
  });

  it("blocks redirect responses unless explicitly enabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://192.168.1.3/" },
    })));
    const fetchTarget = createTargetFetcher({
      allowedTargets: "192.168.0.0/16",
      allowTargetRedirects: false,
      maxTargetRedirects: 0,
    });

    await expect(fetchTarget("http://192.168.1.2")).rejects.toThrow("target redirect is not allowed");

    vi.unstubAllGlobals();
  });
});
