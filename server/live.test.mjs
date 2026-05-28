import { describe, expect, it, vi } from "vitest";

import { createLive } from "./live.mjs";

function createResponseRecorder() {
  const chunks = [];
  return {
    destroyed: false,
    chunks,
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk) => {
      chunks.push(chunk);
    }),
  };
}

describe("live stream", () => {
  it("does not emit stale saved offline status when a fresh snapshot exists", () => {
    const store = {
      resolveHistoryKey: () => ({ deviceKey: "psn-1", target: "http://device.local" }),
      getTargetByHistoryKey: () => ({ lastStatus: "offline", lastError: "previous failure" }),
      savedProxyTarget: () => "http://device.local",
    };
    const live = createLive({
      store,
      getConfig: () => ({ targetUrl: "http://device.local", targets: [] }),
      runCollector: vi.fn(),
    });
    live.broadcast({
      type: "snapshot",
      deviceKey: "psn-1",
      targetUrl: "http://device.local",
      ts: 1000,
      metrics: {},
      heap: null,
      machineInfo: {},
    });

    const req = { on: vi.fn() };
    const res = createResponseRecorder();
    live.handleLive(req, res, new URL("http://localhost/api/live?target=http%3A%2F%2Fdevice.local"));

    const body = res.chunks.join("");
    expect(body).toContain("event: snapshot");
    expect(body).not.toContain("event: status");
    expect(body).not.toContain("previous failure");
  });
});
