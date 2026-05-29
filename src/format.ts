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

const resetReasonMap: Map<number, { name: string; zh: string; en: string }> = new Map([
  [0, { name: "ESP_RST_UNKNOWN", zh: "原因不明", en: "Unknown reason" }],
  [1, { name: "ESP_RST_POWERON", zh: "上电复位", en: "Power-on reset" }],
  [2, { name: "ESP_RST_EXT", zh: "外部 RESET 引脚", en: "External reset pin" }],
  [3, { name: "ESP_RST_SW", zh: "主动重启", en: "Software restart" }],
  [4, { name: "ESP_RST_PANIC", zh: "异常或 panic", en: "Exception or panic" }],
  [5, { name: "ESP_RST_INT_WDT", zh: "中断看门狗", en: "Interrupt watchdog" }],
  [6, { name: "ESP_RST_TASK_WDT", zh: "任务看门狗", en: "Task watchdog" }],
  [7, { name: "ESP_RST_WDT", zh: "其它看门狗", en: "Other watchdog" }],
  [8, { name: "ESP_RST_DEEPSLEEP", zh: "Deep sleep 唤醒复位", en: "Deep-sleep wake reset" }],
  [9, { name: "ESP_RST_BROWNOUT", zh: "欠压复位", en: "Brownout reset" }],
  [10, { name: "ESP_RST_SDIO", zh: "SDIO 复位", en: "SDIO reset" }],
  [11, { name: "ESP_RST_USB", zh: "USB 外设复位", en: "USB peripheral reset" }],
  [12, { name: "ESP_RST_JTAG", zh: "JTAG 复位", en: "JTAG reset" }],
  [13, { name: "ESP_RST_EFUSE", zh: "eFuse 错误", en: "eFuse error" }],
  [14, { name: "ESP_RST_PWR_GLITCH", zh: "电源毛刺检测", en: "Power glitch detected" }],
  [15, { name: "ESP_RST_CPU_LOCKUP", zh: "CPU 锁死复位", en: "CPU lockup reset" }],
]);

export const formatResetReason = (reason: number, language: "zh" | "en") => {
  const item = resetReasonMap.get(reason);
  if (!item) return `ESP_RST_${reason} · ${language === "zh" ? "未识别复位原因" : "Unrecognized reset reason"}`;
  return `${item.name} · ${language === "zh" ? item.zh : item.en}`;
};

export const protocolName = (protocol: number) => {
  if (protocol >= 16) return "PD";
  if (protocol > 0) return `FC ${protocol}`;
  return "USB";
};

export const validTemperature = (temperature: number | null | undefined) =>
  Number.isFinite(temperature) && Number(temperature) > 0 ? Number(temperature) : null;

export const maxTemperature = (temperatures: Array<number | null | undefined>) => {
  const valid = temperatures.map(validTemperature).filter((temperature): temperature is number => temperature != null);
  return valid.length > 0 ? Math.max(...valid) : null;
};

export const formatTemperature = (temperature: number | null | undefined) => {
  const valid = validTemperature(temperature);
  return valid == null ? "N/A" : `${valid}C`;
};

export const temperatureLevel = (temperature: number | null | undefined) => {
  const valid = validTemperature(temperature);
  if (valid == null) return "cool";
  if (valid >= 100) return "hot";
  if (valid >= 85) return "warm";
  return "cool";
};

export const kilobytes = (bytes: number) => `${(bytes / 1024).toFixed(1)}KB`;

export const milliwattHours = (raw: number) => `${(raw / 1_000_000).toFixed(3)}mWh`;
