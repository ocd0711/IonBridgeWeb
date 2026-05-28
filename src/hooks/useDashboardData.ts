import React from "react";

import {
  fetchDashboardData,
  fetchOfflineDashboardData,
  isAuthRequiredError,
  liveStreamUrl,
  mergeLiveDashboardData,
  type LiveDashboardSnapshot,
  type LiveStatusEvent,
  type ServerSession,
} from "../api";

export type DashboardData = Awaited<ReturnType<typeof fetchDashboardData>>;
export type LiveTransportState = "connecting" | "sse" | "reconnecting" | "fallback";

export function useDashboardData(
  targetUrl: string,
  refreshIntervalMs: number,
  enabled: boolean,
  onConfigUpdate?: (config: ServerSession["config"]) => void,
  onAuthRequired?: () => void,
) {
  const [data, setData] = React.useState<DashboardData | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);
  const [transportState, setTransportState] = React.useState<LiveTransportState>("connecting");

  React.useEffect(() => {
    let alive = true;
    let lastSnapshotAt = 0;
    let refreshInFlight = false;
    let eventSource: EventSource | null = null;
    let initialTimer = 0;
    setData(null);
    setUpdatedAt(null);
    setTransportState("connecting");
    if (!enabled || !targetUrl.trim()) return;

    async function refresh(offlineOnly = false) {
      if (refreshInFlight) return;
      refreshInFlight = true;
      const startedAt = Date.now();
      try {
        const next = offlineOnly ? await fetchOfflineDashboardData(targetUrl) : await fetchDashboardData(targetUrl);
        if (!alive || lastSnapshotAt > startedAt) return;
        setData(next);
        setUpdatedAt(new Date());
        if (offlineOnly || !lastSnapshotAt || next.source !== "device") setTransportState("fallback");
      } catch (error) {
        if (isAuthRequiredError(error)) {
          onAuthRequired?.();
        }
      } finally {
        refreshInFlight = false;
      }
    }

    const supportsLiveStream = typeof EventSource !== "undefined";
    if (supportsLiveStream) {
      eventSource = new EventSource(liveStreamUrl(targetUrl), { withCredentials: true });
      eventSource.onopen = () => {
        if (!alive) return;
        setTransportState((current) => current === "fallback" ? current : "connecting");
      };
      eventSource.onerror = () => {
        if (!alive) return;
        setTransportState((current) => current === "fallback" ? current : "reconnecting");
        void refresh();
      };
      eventSource.addEventListener("snapshot", (event) => {
        if (!alive) return;
        lastSnapshotAt = Date.now();
        setTransportState("sse");
        const snapshot = JSON.parse((event as MessageEvent).data) as LiveDashboardSnapshot;
        setData((current) => mergeLiveDashboardData(current, snapshot));
        setUpdatedAt(new Date(snapshot.ts));
        if (snapshot.config) onConfigUpdate?.(snapshot.config);
      });
      eventSource.addEventListener("status", (event) => {
        if (!alive) return;
        const status = JSON.parse((event as MessageEvent).data) as LiveStatusEvent;
        setTransportState((current) => lastSnapshotAt ? "sse" : current);
        if (status.config) onConfigUpdate?.(status.config);
        if (status.status === "offline") void refresh(true);
      });
    }
    initialTimer = window.setTimeout(() => {
      if (lastSnapshotAt) return;
      refresh();
    }, supportsLiveStream ? Math.min(1500, Math.max(500, refreshIntervalMs / 2)) : 0);
    const timer = window.setInterval(() => {
      if (lastSnapshotAt && Date.now() - lastSnapshotAt < refreshIntervalMs * 2.5) return;
      refresh();
    }, refreshIntervalMs);

    return () => {
      alive = false;
      eventSource?.close();
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [targetUrl, refreshIntervalMs, refreshToken, enabled, onConfigUpdate, onAuthRequired]);

  return { data, transportState, updatedAt, retry: () => setRefreshToken((token) => token + 1) };
}
