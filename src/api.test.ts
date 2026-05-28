import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthRequiredError,
  fetchDashboardData,
  fetchOfflineDashboardData,
  normalizeDeviceTarget,
} from "./api";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
  });
}

describe("api target normalization", () => {
  it("keeps explicit protocols and adds http for bare hosts", () => {
    expect(normalizeDeviceTarget("cp02.local")).toBe("http://cp02.local");
    expect(normalizeDeviceTarget("http://192.168.1.2/")).toBe("http://192.168.1.2");
    expect(normalizeDeviceTarget("https://example.test/device")).toBe("https://example.test/device");
  });
});

describe("api auth handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not hide 401 behind offline fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401)));

    await expect(fetchDashboardData("http://device.local")).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe("offline dashboard fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds an offline dashboard from server history without touching device endpoints", async () => {
    stubLocalStorage();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/api/history?");
      return jsonResponse({
        rows: [
          {
            ts: 1000,
            target: "http://device.local",
            port: 1,
            voltage: 9000,
            current: 2000000,
            temperature_c: 42,
            power_w: 18,
            attached: true,
            protocol: "PD",
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const dashboard = await fetchOfflineDashboardData("http://device.local");

    expect(dashboard.source).toBe("offline");
    expect(dashboard.metrics.ports).toHaveLength(1);
    expect(dashboard.metrics.ports[0].id).toBe(1);
    expect(dashboard.history.ports[0].samples[0].temperature_c).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to mock data when server history is empty", async () => {
    stubLocalStorage();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ rows: [] })));

    const dashboard = await fetchOfflineDashboardData("http://device.local");

    expect(dashboard.source).toBe("mock");
  });
});
