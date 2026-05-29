import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthRequiredError,
  fetchDashboardData,
  fetchOfflineDashboardData,
  fetchServerHistory,
  liveStreamUrl,
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

describe("api device identity parameters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses PSN instead of target URL for live streams when available", () => {
    expect(liveStreamUrl("http://192.168.31.248", "psn-1")).toBe("/api/live?device=psn-1");
  });

  it("uses PSN instead of target URL for history queries when available", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ rows: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchServerHistory({
      targetUrl: "http://192.168.31.248",
      deviceKey: "psn-1",
      hours: 1,
      port: null,
    });

    const requestUrl = String((fetchMock.mock.calls as unknown as Array<[RequestInfo | URL]>)[0][0]);
    expect(requestUrl).toContain("/api/history?device=psn-1");
    expect(requestUrl).not.toContain("192.168.31.248");
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

describe("online dashboard history", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges recent server temperature history into the live rolling chart", async () => {
    stubLocalStorage();
    const sampleTs = Date.now() - 30_000;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/metrics.json")) {
        return jsonResponse({
          ports: [
            {
              id: 1,
              active: true,
              state: "ATTACHED",
              port_type: "C",
              attached: true,
              charging_duration_seconds: 0,
              fc_protocol: 0,
              current: 1000000,
              voltage: 9000,
              die_temperature: 44,
              vin_value: 0,
              session_id: 0,
              session_charge: 0,
              power_budget: 100,
              pd_status: null,
            },
          ],
          system: {
            chip: "ESP32",
            cores: 2,
            cpu_freq_mhz: 240,
            idf_version: "idf",
            app_version: "app",
            boot_time_seconds: 1,
            reset_reason: 0,
            free_heap: 1,
          },
          tasks: [],
          wifi: { ssid: "wifi", bssid: "bssid", channel: 1, rssi: -50 },
        });
      }
      if (url.includes("/porthistoryz")) {
        return jsonResponse({
          sample_period_ms: 30000,
          ports: [{ port: 1, samples: [{ voltage: 9000, current: 1000000, ts: sampleTs }] }],
        });
      }
      if (url.includes("/api/history")) {
        return jsonResponse({
          rows: [
            {
              ts: sampleTs,
              target: "http://device.local",
              port: 1,
              voltage: 9000,
              current: 1000000,
              temperature_c: 55,
              power_w: 9,
              attached: true,
              protocol: "PD",
            },
          ],
        });
      }
      if (url.includes("/heapz")) return jsonResponse({ total_free: 1, total_allocated: 1, largest_free_block: 1, min_free: 1, allocated_blocks: 1, free_blocks: 1, total_blocks: 2 });
      return new Response("window.__INFOZ={\"psn\":\"psn-1\",\"ble_mac\":\"\",\"wifi_mac\":\"\",\"hw_rev\":\"\",\"device_model\":\"\",\"device_name\":\"\",\"product_family\":\"\",\"product_color\":\"\",\"esp32_version\":\"\",\"mcu_version\":\"\",\"fpga_version\":\"\",\"zrlib_version\":\"\",\"country_code\":\"\",\"mdns_hostname\":\"\"};");
    });
    vi.stubGlobal("fetch", fetchMock);

    const dashboard = await fetchDashboardData("http://device.local", "psn-1");
    const historicalSample = dashboard.history.ports[0].samples.find((sample) => sample.ts === sampleTs);

    expect(historicalSample?.temperature_c).toBe(55);
  });
});
