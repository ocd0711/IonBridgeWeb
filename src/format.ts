import type { PortMetrics } from "./types";

export const portLabel = (port: PortMetrics) =>
  port.id === 0 ? "A" : `C${port.id}`;

export const watts = (port: PortMetrics) =>
  (port.voltage * port.current) / 1_000_000;

export const volts = (millivolts: number) => millivolts / 1000;

export const amps = (milliamps: number) => milliamps / 1000;

export const formatDuration = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ${hours % 24}h`;

  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo ${days % 30}d`;

  const years = Math.floor(days / 365);
  const restDays = days % 365;
  const restMonths = Math.floor(restDays / 30);
  return restMonths > 0 ? `${years}y ${restMonths}mo` : `${years}y`;
};

export const protocolName = (protocol: number) => {
  if (protocol >= 16) return "PD";
  if (protocol > 0) return `FC ${protocol}`;
  return "USB";
};

export const temperatureLevel = (temperature: number) => {
  if (temperature >= 100) return "hot";
  if (temperature >= 85) return "warm";
  return "cool";
};

export const kilobytes = (bytes: number) => `${(bytes / 1024).toFixed(1)}KB`;

export const milliwattHours = (raw: number) => `${(raw / 1_000_000).toFixed(3)}mWh`;
