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
export type LiveTransportState = "connecting" | "mqtt" | "mqtt-http" | "http" | "reconnecting" | "fallback";
export type FrontendTransportState = "connecting" | "sse" | "reconnecting" | "http";
export type DeviceStatus = LiveStatusEvent["status"];

export function isMqttHeartbeatFresh(lastMqttPortSnapshotAt: number, now: number, refreshIntervalMs: number) {
  return Boolean(lastMqttPortSnapshotAt) && now - lastMqttPortSnapshotAt < Math.max(5000, refreshIntervalMs * 2);
}

export function useDashboardData(
  targetUrl: string,
  deviceKey: string | null | undefined,
  refreshIntervalMs: number,
  enabled: boolean,
  onConfigUpdate?: (config: ServerSession["config"]) => void,
  onAuthRequired?: () => void,
) {
  const [data, setData] = React.useState<DashboardData | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);
  const [transportState, setTransportState] = React.useState<LiveTransportState>("connecting");
  const [frontendTransportState, setFrontendTransportState] = React.useState<FrontendTransportState>("connecting");
  const [deviceStatus, setDeviceStatus] = React.useState<DeviceStatus>("unknown");

  React.useEffect(() => {
    let alive = true;
    let lastSnapshotAt = 0;
    let lastMqttPortSnapshotAt = 0;
    let refreshInFlight = false;
    let eventSource: EventSource | null = null;
    let initialTimer = 0;
    setData(null);
    setUpdatedAt(null);
    setTransportState("connecting");
    setFrontendTransportState("connecting");
    setDeviceStatus("unknown");
    if (!enabled || !targetUrl.trim()) return;

    async function refresh(offlineOnly = false) {
      if (refreshInFlight) return;
      refreshInFlight = true;
      const startedAt = Date.now();
      try {
        const next = offlineOnly ? await fetchOfflineDashboardData(targetUrl, deviceKey) : await fetchDashboardData(targetUrl, deviceKey);
        if (!alive || lastSnapshotAt > startedAt) return;
        setFrontendTransportState("http");
        if (next.source === "device") {
          const ts = Date.now();
          setData((current) => mergeLiveDashboardData(current, {
            type: "snapshot",
            source: "http",
            deviceKey: deviceKey || next.machineInfo.psn || "",
            targetUrl,
            ts,
            metrics: next.metrics,
            heap: next.heap,
            machineInfo: next.machineInfo,
          }));
          setTransportState(isMqttHeartbeatFresh(lastMqttPortSnapshotAt, ts, refreshIntervalMs) ? "mqtt-http" : "http");
        } else {
          setData(next);
          setTransportState("fallback");
        }
        setUpdatedAt(new Date());
        setDeviceStatus(next.source === "device" ? "online" : next.source === "offline" ? "offline" : "unknown");
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
      eventSource = new EventSource(liveStreamUrl(targetUrl, deviceKey), { withCredentials: true });
      eventSource.onopen = () => {
        if (!alive) return;
        setTransportState((current) => current === "fallback" ? current : "connecting");
        setFrontendTransportState("connecting");
      };
      eventSource.onerror = () => {
        if (!alive) return;
        setTransportState((current) => current === "fallback" ? current : "reconnecting");
        setFrontendTransportState("reconnecting");
        void refresh();
      };
      eventSource.addEventListener("snapshot", (event) => {
        if (!alive) return;
        const receivedAt = Date.now();
        lastSnapshotAt = receivedAt;
        setFrontendTransportState("sse");
        const snapshot = JSON.parse((event as MessageEvent).data) as LiveDashboardSnapshot;
        if (snapshot.source === "mqtt" && snapshot.metrics.ports.length > 0) {
          lastMqttPortSnapshotAt = receivedAt;
          setTransportState("mqtt");
        } else if (snapshot.source === "mqtt") {
          setTransportState((current) => (
            isMqttHeartbeatFresh(lastMqttPortSnapshotAt, receivedAt, refreshIntervalMs)
              ? "mqtt"
              : current
          ));
        } else if (snapshot.source === "http") {
          setTransportState(isMqttHeartbeatFresh(lastMqttPortSnapshotAt, receivedAt, refreshIntervalMs) ? "mqtt-http" : "http");
        } else {
          setTransportState("http");
        }
        setDeviceStatus("online");
        setData((current) => mergeLiveDashboardData(current, snapshot));
        setUpdatedAt(new Date(snapshot.ts));
        if (snapshot.config) onConfigUpdate?.(snapshot.config);
      });
      eventSource.addEventListener("status", (event) => {
        if (!alive) return;
        setFrontendTransportState("sse");
        const status = JSON.parse((event as MessageEvent).data) as LiveStatusEvent;
        if (status.config) onConfigUpdate?.(status.config);
        if (status.status === "offline") {
          const mqttFresh = isMqttHeartbeatFresh(lastMqttPortSnapshotAt, Date.now(), refreshIntervalMs);
          if (mqttFresh) {
            setDeviceStatus("online");
            setTransportState("mqtt");
            return;
          }
          if (!isMqttHeartbeatFresh(lastMqttPortSnapshotAt, Date.now(), refreshIntervalMs)) {
            setDeviceStatus("offline");
          }
          void refresh();
          return;
        }
        setDeviceStatus(status.status);
      });
    }
    initialTimer = window.setTimeout(() => {
      if (lastSnapshotAt) return;
      refresh();
    }, supportsLiveStream ? Math.min(1500, Math.max(500, refreshIntervalMs / 2)) : 0);
    const timer = window.setInterval(() => {
      if (isMqttHeartbeatFresh(lastMqttPortSnapshotAt, Date.now(), refreshIntervalMs)) return;
      if (lastSnapshotAt && Date.now() - lastSnapshotAt < refreshIntervalMs * 2) return;
      refresh();
    }, refreshIntervalMs);

    return () => {
      alive = false;
      eventSource?.close();
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [targetUrl, deviceKey, refreshIntervalMs, refreshToken, enabled, onConfigUpdate, onAuthRequired]);

  return { data, deviceStatus, frontendTransportState, transportState, updatedAt, retry: () => setRefreshToken((token) => token + 1) };
}
