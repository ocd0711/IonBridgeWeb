import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Cpu,
  Database,
  Filter,
  Gauge,
  HardDrive,
  Pencil,
  Radio,
  RefreshCw,
  Settings,
  Zap,
} from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  fetchDashboardData,
  fetchServerHistory,
  getServerSession,
  liveStreamUrl,
  login,
  mergeLiveDashboardData,
  normalizeDeviceTarget,
  saveServerConfig,
  setActiveServerTarget,
  deleteSavedTarget,
  updateSavedTargetNote,
  type LiveDashboardSnapshot,
  type LiveStatusEvent,
  type SavedTarget,
  type ServerSession,
} from "./api";
import {
  deviceProfiles,
  resolveDeviceProfile,
  type DeviceVisualProfile,
} from "./deviceProfiles";
import {
  amps,
  formatDuration,
  kilobytes,
  milliwattHours,
  portLabel,
  protocolName,
  temperatureLevel,
  volts,
  watts,
} from "./format";
import type { ServerHistoryRow } from "./api";
import type { HeapMetrics, MachineInfo, Metrics, PortHistory, PortMetrics, TaskMetrics } from "./types";
import "./styles.css";

type DashboardData = Awaited<ReturnType<typeof fetchDashboardData>>;
const DEVICE_TARGET_STORAGE_KEY = "ionbridge:device-target:v1";
const REFRESH_INTERVAL_STORAGE_KEY = "ionbridge:refresh-interval:v1";
const LANGUAGE_STORAGE_KEY = "ionbridge:language:v1";
const DEFAULT_REFRESH_INTERVAL_MS = 30000;
type Language = "zh" | "en";
type TranslationKey = keyof typeof translations.zh;
type LiveTransportState = "connecting" | "sse" | "reconnecting" | "fallback";

const translations = {
  zh: {
    sourceDevice: "实时",
    sourceOffline: "离线",
    sourceMock: "模拟",
    statusOnline: "在线",
    statusOffline: "离线",
    statusUnknown: "未知",
    cp02Title: "小电拼 CP-02 监控面板",
    mirrorTitle: "小电拼 Mirror 监控面板",
    amberSubhead: "琥珀状态屏 ingBar 的全端遥测视图",
    ledSubhead: "LED 功率条的全端遥测视图",
    realtimeSummary: "实时摘要",
    savedTargets: "已保存设备地址",
    removeTargetTitle: "移除设备和对应历史数据",
    editTargetNote: "编辑设备备注",
    targetAddress: "设备目标地址",
    targetNote: "设备备注",
    targetPlaceholder: "当前设备地址",
    targetNotePlaceholder: "备注，例如书房 / 工位 / 旅行箱",
    intervalSeconds: "采集间隔，单位秒",
    validatingDevice: "正在验证设备...",
    saveConfig: "保存配置",
    connectFailed: "连接失败，未保存设备",
    loginTitle: "登录监控面板",
    loginPassword: "登录密码",
    passwordPlaceholder: "密码",
    loginButton: "登录",
    passwordWrong: "密码不正确",
    productImage: "小电拼产品图",
    connecting: "连接中",
    targetOffline: "设备离线",
    connectingTitle: "正在连接设备",
    offlineTitle: "无法连接设备",
    connectingHelp: "正在验证设备地址和 PSN。你可以直接修改地址并保存。",
    offlineHelp: "请确认设备 IP 或 mDNS 地址，保存后面板会重新拉取 metrics、历史和设备信息。",
    amberScreen: "琥珀状态屏",
    ledStrip: "LED 功率条",
    deviceFront: "设备正面",
    sideC4: "侧面 C4 端口",
    attached: "已连接",
    idle: "空闲",
    portLimit: "端口上限",
    totalPower: "实时功率",
    modelMax: "型号上限",
    thermalPeak: "最高温度",
    thermalDetail: "端口 die temperature 最高值",
    heapUsed: "内存占用",
    available: "可用",
    runtime: "运行时间",
    diagnostics: "IonBridge 诊断",
    diagnosticsTitle: "设备资料与端口历史",
    diagnosticsAria: "诊断资料",
    diagnosticsTabs: "诊断视图",
    tabDevice: "设备",
    tabHeap: "内存",
    tabPorts: "端口",
    machineInfo: "设备信息",
    deviceModel: "设备型号",
    deviceName: "设备名称",
    productFamily: "产品系列",
    productColor: "产品颜色",
    hwRev: "硬件版本",
    country: "国家/地区",
    heapStatus: "内存状态",
    heapUsedShort: "已用",
    heapFree: "可用内存",
    heapAllocated: "已分配内存",
    heapLargestFree: "最大可用块",
    heapMinFree: "历史最低可用",
    heapAllocatedBlocks: "已分配块",
    heapFreeBlocks: "空闲块",
    heapTotalBlocks: "总块数",
    perPortHistory: "每个端口数据与历史",
    powerTrend: "功率趋势",
    selected: "已选择",
    sideSuffix: "侧边",
    min: "最低",
    avg: "平均",
    max: "峰值",
    state: "状态",
    protocol: "协议",
    voltage: "电压",
    current: "电流",
    power: "功率",
    session: "本次时长",
    sessionCharge: "本次电量",
    portTemp: "端口温度",
    sessionId: "会话 ID",
    pdStatus: "PD 状态",
    pdAvailable: "可用",
    noPdData: "无 PD 数据",
    collapsed: "端口详情已收起",
    collapsedHint: "点击任意端口展开电压、电流、协议、会话电量和 60 分钟功率曲线。",
    local60m: "本地 60 分钟滚动缓存",
    deviceMinutesPrefix: "设备",
    deviceMinutesSuffix: "分钟 + 本地补样",
    waitingSamples: "等待历史样本",
    profileSwitchAria: "外观主题切换",
    appearancePreview: "外观预览",
    appearanceProfile: "外观主题",
    detected: "已识别",
    serverHistory: "服务端历史",
    longHistory: "长时间历史与筛选",
    autoRefreshPrefix: "自动跟随 metrics 刷新",
    historyFilters: "历史筛选",
    preset: "预设",
    custom: "自定义",
    from: "开始",
    to: "结束",
    allPorts: "全部端口",
    samples: "样本",
    highestTemp: "最高温",
    readingHistory: "正在读取服务端历史...",
    invalidRange: "自定义时间范围无效",
    emptyHistory: "当前筛选范围还没有历史样本",
    unavailableHistory: "当前运行模式没有可用的服务端历史",
    sqliteHint: "生产服务会持续写入 SQLite，开发模式下仍可使用设备 60 分钟历史。",
    portTimeline: "端口时间线",
    livePowerAndTemp: "实时功率与温度",
    taskLoad: "任务负载",
    systemStatus: "系统状态",
    loading: "ingBar 正在启动...",
    portTelemetry: "端口遥测",
    language: "语言",
    chinese: "中",
    english: "EN",
    deviceSettings: "设备设置",
    connectionSettings: "连接设置",
    transportConnecting: "推送连接中",
    transportSse: "SSE 推送",
    transportReconnecting: "推送重连中",
    transportFallback: "HTTP 回退",
  },
  en: {
    sourceDevice: "Live",
    sourceOffline: "Offline",
    sourceMock: "Mock",
    statusOnline: "Online",
    statusOffline: "Offline",
    statusUnknown: "Unknown",
    cp02Title: "CoCan CP-02 Monitor",
    mirrorTitle: "CoCan Mirror Monitor",
    amberSubhead: "Full-stack telemetry for the amber ingBar status display",
    ledSubhead: "Full-stack telemetry for the LED power strip",
    realtimeSummary: "Realtime summary",
    savedTargets: "Saved device targets",
    removeTargetTitle: "Remove this device and its history",
    editTargetNote: "Edit device note",
    targetAddress: "Device target address",
    targetNote: "Device note",
    targetPlaceholder: "Current device address",
    targetNotePlaceholder: "Note, e.g. desk / lab / travel kit",
    intervalSeconds: "Collection interval in seconds",
    validatingDevice: "Verifying device...",
    saveConfig: "Save config",
    connectFailed: "Connection failed. Device was not saved.",
    loginTitle: "Sign in to monitor",
    loginPassword: "Login password",
    passwordPlaceholder: "Password",
    loginButton: "Sign in",
    passwordWrong: "Incorrect password",
    productImage: "CoCan product image",
    connecting: "Connecting",
    targetOffline: "Device offline",
    connectingTitle: "Connecting to device",
    offlineTitle: "Unable to reach device",
    connectingHelp: "Verifying the device address and PSN. You can edit the address and save it directly.",
    offlineHelp: "Check the device IP or mDNS address. After saving, the panel will reload metrics, history, and device info.",
    amberScreen: "Amber status display",
    ledStrip: "LED power strip",
    deviceFront: "Device front face",
    sideC4: "Side C4 port",
    attached: "Attached",
    idle: "Idle",
    portLimit: "Port limit",
    totalPower: "Realtime power",
    modelMax: "model max",
    thermalPeak: "Thermal peak",
    thermalDetail: "highest port die temperature",
    heapUsed: "Heap used",
    available: "free",
    runtime: "Runtime",
    diagnostics: "IonBridge diagnostics",
    diagnosticsTitle: "Device info and port history",
    diagnosticsAria: "Diagnostics",
    diagnosticsTabs: "Diagnostic views",
    tabDevice: "Device",
    tabHeap: "Heap",
    tabPorts: "Ports",
    machineInfo: "Machine Info",
    deviceModel: "Device Model",
    deviceName: "Device Name",
    productFamily: "Product Family",
    productColor: "Product Color",
    hwRev: "HW Rev",
    country: "Country",
    heapStatus: "Heap status",
    heapUsedShort: "used",
    heapFree: "Total Free",
    heapAllocated: "Total Allocated",
    heapLargestFree: "Largest Free Block",
    heapMinFree: "Min Free Ever",
    heapAllocatedBlocks: "Allocated Blocks",
    heapFreeBlocks: "Free Blocks",
    heapTotalBlocks: "Total Blocks",
    perPortHistory: "Per-port data and history",
    powerTrend: "Power trend",
    selected: "Selected",
    sideSuffix: "Side",
    min: "Min",
    avg: "Avg",
    max: "Max",
    state: "State",
    protocol: "Protocol",
    voltage: "Voltage",
    current: "Current",
    power: "Power",
    session: "Session",
    sessionCharge: "Session charge",
    portTemp: "Port temp",
    sessionId: "Session ID",
    pdStatus: "PD Status",
    pdAvailable: "Available",
    noPdData: "No PD data",
    collapsed: "Port details collapsed",
    collapsedHint: "Click any port to expand voltage, current, protocol, session charge, and the 60-minute power chart.",
    local60m: "Local 60m rolling buffer",
    deviceMinutesPrefix: "Device",
    deviceMinutesSuffix: "m + local fill",
    waitingSamples: "Waiting for samples",
    profileSwitchAria: "Appearance profile switcher",
    appearancePreview: "Appearance preview",
    appearanceProfile: "Appearance profile",
    detected: "Detected",
    serverHistory: "Server history",
    longHistory: "Long history and filters",
    autoRefreshPrefix: "Auto-refreshes with metrics",
    historyFilters: "History filters",
    preset: "Preset",
    custom: "Custom",
    from: "From",
    to: "To",
    allPorts: "All ports",
    samples: "Samples",
    highestTemp: "Temp",
    readingHistory: "Reading server history...",
    invalidRange: "Invalid custom time range",
    emptyHistory: "No samples in the current filter range",
    unavailableHistory: "Server history is unavailable in the current runtime mode",
    sqliteHint: "Production service continuously writes SQLite. Development mode still uses the device 60-minute history.",
    portTimeline: "Port timeline",
    livePowerAndTemp: "Realtime power and temperature",
    taskLoad: "Task load",
    systemStatus: "System status",
    loading: "ingBar warming up...",
    portTelemetry: "Port telemetry",
    language: "Language",
    chinese: "中",
    english: "EN",
    deviceSettings: "Device settings",
    connectionSettings: "Connection settings",
    transportConnecting: "Live connecting",
    transportSse: "SSE live",
    transportReconnecting: "Live reconnecting",
    transportFallback: "HTTP fallback",
  },
} as const;

function readDeviceTarget() {
  try {
    return localStorage.getItem(DEVICE_TARGET_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDeviceTarget(targetUrl: string) {
  try {
    if (targetUrl) {
      localStorage.setItem(DEVICE_TARGET_STORAGE_KEY, targetUrl);
    } else {
      localStorage.removeItem(DEVICE_TARGET_STORAGE_KEY);
    }
  } catch {
    // Non-critical. The current session still uses the configured target.
  }
}

function readRefreshInterval() {
  try {
    const stored = Number(localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 1000 ? stored : DEFAULT_REFRESH_INTERVAL_MS;
  } catch {
    return DEFAULT_REFRESH_INTERVAL_MS;
  }
}

function writeRefreshInterval(intervalMs: number) {
  try {
    localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(intervalMs));
  } catch {
    // Non-critical. The current session still uses the configured interval.
  }
}

function readLanguage(): Language {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

function writeLanguage(language: Language) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Non-critical. The current session still uses the selected language.
  }
}

function clampRefreshInterval(intervalMs: number) {
  return Math.max(1000, Math.min(60000, Math.round(intervalMs)));
}

function translate(language: Language, key: TranslationKey) {
  return translations[language][key];
}

function sourceLabel(language: Language, source: DashboardData["source"]) {
  if (source === "device") return translate(language, "sourceDevice");
  if (source === "offline") return translate(language, "sourceOffline");
  return translate(language, "sourceMock");
}

function transportLabel(language: Language, state: LiveTransportState) {
  if (state === "sse") return translate(language, "transportSse");
  if (state === "reconnecting") return translate(language, "transportReconnecting");
  if (state === "fallback") return translate(language, "transportFallback");
  return translate(language, "transportConnecting");
}

function targetStatusLabel(language: Language, status: SavedTarget["lastStatus"]) {
  if (status === "online") return translate(language, "statusOnline");
  if (status === "offline") return translate(language, "statusOffline");
  return translate(language, "statusUnknown");
}

const I18nContext = React.createContext<{
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
}>({
  language: "zh",
  setLanguage: () => undefined,
  t: (key) => translations.zh[key],
});

function useI18n() {
  return React.useContext(I18nContext);
}

function LanguageToggle() {
  const { language, setLanguage, t } = useI18n();

  return (
    <div className="language-toggle" aria-label={t("language")} role="group">
      <button
        className={language === "zh" ? "active" : ""}
        onClick={() => setLanguage("zh")}
        type="button"
      >
        {t("chinese")}
      </button>
      <button
        className={language === "en" ? "active" : ""}
        onClick={() => setLanguage("en")}
        type="button"
      >
        {t("english")}
      </button>
    </div>
  );
}

function useDashboardData(
  targetUrl: string,
  refreshIntervalMs: number,
  enabled: boolean,
  onConfigUpdate?: (config: ServerSession["config"]) => void,
) {
  const [data, setData] = React.useState<DashboardData | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);
  const [refreshToken, setRefreshToken] = React.useState(0);
  const [transportState, setTransportState] = React.useState<LiveTransportState>("connecting");

  React.useEffect(() => {
    let alive = true;
    let lastLiveAt = 0;
    let lastSnapshotAt = 0;
    let eventSource: EventSource | null = null;
    let initialTimer = 0;
    setData(null);
    setUpdatedAt(null);
    setTransportState("connecting");
    if (!enabled || !targetUrl.trim()) return;

    async function refresh() {
      const next = await fetchDashboardData(targetUrl);
      if (!alive) return;
      setData(next);
      setUpdatedAt(new Date());
      if (!lastLiveAt) setTransportState("fallback");
    }

    const supportsLiveStream = typeof EventSource !== "undefined";
    if (supportsLiveStream) {
      eventSource = new EventSource(liveStreamUrl(targetUrl), { withCredentials: true });
      eventSource.onopen = () => {
        if (!alive) return;
        lastLiveAt = Date.now();
        setTransportState("sse");
      };
      eventSource.onerror = () => {
        if (!alive) return;
        setTransportState("reconnecting");
      };
      eventSource.addEventListener("snapshot", (event) => {
        if (!alive) return;
        lastLiveAt = Date.now();
        lastSnapshotAt = Date.now();
        setTransportState("sse");
        const snapshot = JSON.parse((event as MessageEvent).data) as LiveDashboardSnapshot;
        setData((current) => mergeLiveDashboardData(current, snapshot));
        setUpdatedAt(new Date(snapshot.ts));
        if (snapshot.config) onConfigUpdate?.(snapshot.config);
      });
      eventSource.addEventListener("status", (event) => {
        if (!alive) return;
        lastLiveAt = Date.now();
        setTransportState("sse");
        const status = JSON.parse((event as MessageEvent).data) as LiveStatusEvent;
        if (status.config) onConfigUpdate?.(status.config);
      });
    }
    initialTimer = window.setTimeout(() => {
      if (lastLiveAt) return;
      refresh();
    }, supportsLiveStream ? Math.min(1500, Math.max(500, refreshIntervalMs / 2)) : 0);
    const timer = window.setInterval(() => {
      if (lastLiveAt && Date.now() - lastLiveAt < refreshIntervalMs * 2.5) return;
      refresh();
    }, refreshIntervalMs);

    return () => {
      alive = false;
      eventSource?.close();
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [targetUrl, refreshIntervalMs, refreshToken, enabled, onConfigUpdate]);

  return { data, transportState, updatedAt, retry: () => setRefreshToken((token) => token + 1) };
}

function useServerSettings() {
  const [ready, setReady] = React.useState(false);
  const [passwordRequired, setPasswordRequired] = React.useState(false);
  const [session, setSession] = React.useState<ServerSession | null>(null);

  React.useEffect(() => {
    let alive = true;
    getServerSession().then((nextSession) => {
      if (!alive) return;
      setSession(nextSession);
      if (nextSession) {
        setPasswordRequired(nextSession.passwordEnabled && !nextSession.authenticated);
      }
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { ready, passwordRequired, serverSession: session, setPasswordRequired, setServerSession: setSession };
}

function Header({
  metrics,
  profile,
  source,
  transportState,
  updatedAt,
  targetUrl,
  refreshIntervalMs,
  savedTargets,
  onApply,
  onSelectSavedTarget,
  onDeleteTarget,
  onUpdateTargetNote,
  connectionActionPending,
}: {
  metrics: Metrics;
  profile: DeviceVisualProfile;
  source: DashboardData["source"];
  transportState: LiveTransportState;
  updatedAt: Date | null;
  targetUrl: string;
  refreshIntervalMs: number;
  savedTargets: SavedTarget[];
  onApply: (targetUrl: string, refreshIntervalMs: number, note: string) => void | Promise<void>;
  onSelectSavedTarget: (target: SavedTarget) => void | Promise<void>;
  onDeleteTarget: (targetUrl: string) => void | Promise<void>;
  onUpdateTargetNote: (target: SavedTarget, note: string) => void | Promise<void>;
  connectionActionPending?: boolean;
}) {
  const { language, t } = useI18n();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const totalPower = metrics.ports.reduce((sum, port) => sum + watts(port), 0);
  const hottest = Math.max(...metrics.ports.map((port) => port.die_temperature));
  const productTitle = profile.family === "CP02"
    ? t("cp02Title")
    : t("mirrorTitle");
  const productEyebrow = profile.family === "CP02"
    ? `CP-02 ${profile.variant.toUpperCase()}`
    : `${profile.family} Mirror ${profile.variant.toUpperCase()}`;
  const activeNote = savedTargets.find((target) => target.targetUrl === normalizeDeviceTarget(targetUrl))?.note ?? "";

  return (
    <>
      <header className="app-header">
        <div>
          <p className="eyebrow">{productEyebrow}</p>
          <h1>{productTitle}</h1>
          <p className="subhead">
            {profile.displayKind === "amber" ? t("amberSubhead") : t("ledSubhead")}
          </p>
        </div>
        <div className="header-metrics" aria-label={t("realtimeSummary")}>
          <div className="metric-pill">
            <Zap size={17} />
            <span>{totalPower.toFixed(1)}W</span>
          </div>
          <div className={`metric-pill temp-${temperatureLevel(hottest)}`}>
            <Gauge size={17} />
            <span>{hottest}C</span>
          </div>
          <div className="metric-pill">
            <Radio size={17} />
            <span>{metrics.wifi.rssi}dBm</span>
          </div>
          <div className={`live-chip ${source}`}>
            <span />
            {sourceLabel(language, source)}
            <small>{transportLabel(language, transportState)}</small>
            {updatedAt ? ` ${updatedAt.toLocaleTimeString("zh-CN", { hour12: false })}` : ""}
          </div>
          <SavedTargetsMenu
            activeTargetUrl={targetUrl}
            disabled={connectionActionPending}
            targets={savedTargets}
            onSelect={onSelectSavedTarget}
            onDelete={onDeleteTarget}
            onUpdateNote={onUpdateTargetNote}
          />
          <LanguageToggle />
          <button
            aria-expanded={settingsOpen}
            aria-label={t("deviceSettings")}
            className={`header-action ${settingsOpen ? "active" : ""}`}
            onClick={() => setSettingsOpen((open) => !open)}
            title={t("deviceSettings")}
            type="button"
          >
            <Settings size={17} />
          </button>
        </div>
      </header>
      {settingsOpen ? (
        <section className="device-settings-panel" aria-label={t("deviceSettings")}>
          <div>
            <p className="eyebrow">{t("connectionSettings")}</p>
            <h2>{t("deviceSettings")}</h2>
          </div>
          <DeviceTargetControl
            disabled={connectionActionPending}
            busy={connectionActionPending}
            note={activeNote}
            refreshIntervalMs={refreshIntervalMs}
            targetUrl={targetUrl}
            onApply={onApply}
          />
        </section>
      ) : null}
    </>
  );
}

function SavedTargetsMenu({
  activeTargetUrl,
  disabled = false,
  targets,
  onSelect,
  onDelete,
  onUpdateNote,
}: {
  activeTargetUrl: string;
  disabled?: boolean;
  targets: SavedTarget[];
  onSelect: (target: SavedTarget) => void | Promise<void>;
  onDelete: (targetUrl: string) => void | Promise<void>;
  onUpdateNote: (target: SavedTarget, note: string) => void | Promise<void>;
}) {
  const { language, t } = useI18n();
  const [isDeleting, setIsDeleting] = React.useState("");
  const [isOpen, setIsOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!isOpen) return;
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) return;
      setIsOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);
  if (targets.length === 0) return null;
  const normalizedActive = normalizeDeviceTarget(activeTargetUrl);
  const activeTarget = targets.find((target) => target.targetUrl === normalizedActive) ?? targets[0];
  const activeName = activeTarget.note || activeTarget.deviceKey || activeTarget.targetUrl.replace(/^https?:\/\//, "");

  return (
    <div className="saved-targets" ref={menuRef}>
      <button
        aria-expanded={isOpen}
        className="saved-target-trigger"
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        title={activeTarget.lastError ?? activeTarget.targetUrl}
      >
        <span className={`saved-target-dot ${activeTarget.lastStatus}`} />
        <strong>{activeName}</strong>
        <em>{targetStatusLabel(language, activeTarget.lastStatus)}</em>
        <b>{targets.length}</b>
        <i aria-hidden="true">⌄</i>
      </button>
      {isOpen ? (
        <div className="saved-target-menu" aria-label={t("savedTargets")}>
          {targets.map((target) => {
            const isActive = normalizedActive === target.targetUrl;
            const name = target.note || target.deviceKey || target.targetUrl.replace(/^https?:\/\//, "");
            return (
              <div className={`saved-target ${isActive ? "active" : ""}`} key={target.targetUrl}>
                <button
                  className="saved-target-main"
                  disabled={disabled}
                  type="button"
                  onClick={async () => {
                    if (disabled) return;
                    await onSelect(target);
                    setIsOpen(false);
                  }}
                  title={target.lastError ?? target.targetUrl}
                >
                  <span className={`saved-target-dot ${target.lastStatus}`} />
                  <span className="saved-target-copy">
                    <strong>{name}</strong>
                    <small>{target.note ? `${target.deviceKey ?? ""} · ${target.targetUrl}` : target.targetUrl}</small>
                  </span>
                  <em>{targetStatusLabel(language, target.lastStatus)}</em>
                </button>
                <button
                  className="saved-target-note"
                  disabled={disabled}
                  type="button"
                  onClick={async () => {
                    if (disabled) return;
                    const nextNote = window.prompt(t("targetNote"), target.note ?? "");
                    if (nextNote == null) return;
                    await onUpdateNote(target, nextNote);
                  }}
                  title={t("editTargetNote")}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="saved-target-delete"
                  disabled={disabled || isDeleting === target.targetUrl}
                  type="button"
                  onClick={async () => {
                    if (disabled) return;
                    setIsDeleting(target.targetUrl);
                    try {
                      await onDelete(target.targetUrl);
                    } finally {
                      setIsDeleting("");
                    }
                  }}
                  title={t("removeTargetTitle")}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function DeviceTargetControl({
  targetUrl,
  note = "",
  refreshIntervalMs,
  disabled = false,
  busy = false,
  onApply,
}: {
  targetUrl: string;
  note?: string;
  refreshIntervalMs: number;
  disabled?: boolean;
  busy?: boolean;
  onApply: (targetUrl: string, refreshIntervalMs: number, note: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(targetUrl);
  const [noteDraft, setNoteDraft] = React.useState(note);
  const [intervalDraft, setIntervalDraft] = React.useState(String(refreshIntervalMs / 1000));
  const [isApplying, setIsApplying] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    setDraft(targetUrl);
  }, [targetUrl]);

  React.useEffect(() => {
    setNoteDraft(note);
  }, [note]);

  React.useEffect(() => {
    setIntervalDraft(String(refreshIntervalMs / 1000));
  }, [refreshIntervalMs]);

  return (
    <form
      className="target-control"
      onSubmit={async (event) => {
        event.preventDefault();
        if (isApplying || disabled) return;
        if (!draft.trim()) return;
        setIsApplying(true);
        setError("");
        try {
          await onApply(normalizeDeviceTarget(draft), clampRefreshInterval(Number(intervalDraft) * 1000), noteDraft);
        } catch {
          setError(t("connectFailed"));
        } finally {
          setIsApplying(false);
        }
      }}
    >
      <input
        aria-label={t("targetAddress")}
        disabled={isApplying || disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t("targetPlaceholder")}
      />
      <input
        aria-label={t("targetNote")}
        className="target-note-input"
        disabled={isApplying || disabled}
        value={noteDraft}
        maxLength={80}
        onChange={(event) => setNoteDraft(event.target.value)}
        placeholder={t("targetNotePlaceholder")}
      />
      <input
        aria-label={t("intervalSeconds")}
        title={t("intervalSeconds")}
        className="interval-input"
        min="1"
        max="60"
        step="1"
        type="number"
        disabled={isApplying || disabled}
        value={intervalDraft}
        onChange={(event) => setIntervalDraft(event.target.value)}
      />
      <span className="target-unit">s</span>
      <button disabled={isApplying || disabled} type="submit">
        {isApplying || busy ? t("validatingDevice") : t("saveConfig")}
      </button>
      {error ? <strong className="target-error">{error}</strong> : null}
    </form>
  );
}

function LoginScreen({ onLogin }: { onLogin: (session: ServerSession) => void }) {
  const { t } = useI18n();
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");

  return (
    <main className="login-screen">
      <section className="login-shell">
        <form
          className="login-card"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            try {
              const session = await login(password);
              onLogin(session);
            } catch {
              setError(t("passwordWrong"));
            }
          }}
        >
          <p>IonBridgeWeb</p>
          <LanguageToggle />
          <h1>{t("loginTitle")}</h1>
          <input
            autoFocus
            aria-label={t("loginPassword")}
            placeholder={t("passwordPlaceholder")}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit">{t("loginButton")}</button>
          {error ? <span>{error}</span> : null}
        </form>
        <aside className="login-product" aria-label={t("productImage")}>
          <img src="/login-product.png" alt="" />
        </aside>
      </section>
    </main>
  );
}

function TargetSetupScreen({
  targetUrl,
  refreshIntervalMs,
  savedTargets = [],
  state = "offline",
  connectionActionPending = false,
  onApply,
  onSelectSavedTarget,
  onDeleteTarget,
  onUpdateTargetNote,
}: {
  targetUrl: string;
  refreshIntervalMs: number;
  savedTargets?: SavedTarget[];
  state?: "connecting" | "offline";
  connectionActionPending?: boolean;
  onApply: (targetUrl: string, refreshIntervalMs: number, note: string) => void | Promise<void>;
  onSelectSavedTarget: (target: SavedTarget) => void | Promise<void>;
  onDeleteTarget?: (targetUrl: string) => void | Promise<void>;
  onUpdateTargetNote: (target: SavedTarget, note: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const isConnecting = state === "connecting";
  const activeNote = savedTargets.find((target) => target.targetUrl === normalizeDeviceTarget(targetUrl))?.note ?? "";
  return (
    <main className="target-setup-screen">
      <section className="target-setup-card">
        <div>
          <LanguageToggle />
          <p>{isConnecting ? t("connecting") : t("targetOffline")}</p>
          <h1>{isConnecting ? t("connectingTitle") : t("offlineTitle")}</h1>
          <span>
            {isConnecting ? t("connectingHelp") : t("offlineHelp")}
          </span>
        </div>
        <SavedTargetsMenu
          activeTargetUrl={targetUrl}
          disabled={connectionActionPending || isConnecting}
          targets={savedTargets}
          onSelect={onSelectSavedTarget}
          onDelete={onDeleteTarget ?? (() => undefined)}
          onUpdateNote={onUpdateTargetNote}
        />
        <DeviceTargetControl
          disabled={connectionActionPending || isConnecting}
          busy={connectionActionPending || isConnecting}
          note={activeNote}
          refreshIntervalMs={refreshIntervalMs}
          targetUrl={targetUrl}
          onApply={onApply}
        />
      </section>
    </main>
  );
}

function AmberScreen({
  metrics,
  history,
  profile,
}: {
  metrics: Metrics;
  history: PortHistory;
  profile: DeviceVisualProfile;
}) {
  const { t } = useI18n();
  const totalPower = metrics.ports.reduce((sum, port) => sum + watts(port), 0);
  const peakPower = Math.max(
    totalPower,
    ...history.ports.flatMap((port) => port.samples.map(samplePower)),
  );
  const percent = Math.max(0, Math.min(99, (totalPower / profile.totalPowerBudgetW) * 100));

  return (
    <div className="amber-screen" aria-label={t("amberScreen")}>
      <div className="scanline" />
      <div className="amber-time">
        <span><em>NOW</em>{Math.floor(totalPower).toString().padStart(2, "0")}</span>
        <span><em>60M</em>{Math.floor(peakPower).toString().padStart(2, "0")}</span>
        <span><em>USE</em>{Math.round(percent).toString().padStart(2, "0")}</span>
      </div>
      <div className="amber-caption">W / PEAK / %</div>
      <div className="life-grid" aria-hidden="true">
        {Array.from({ length: 42 }).map((_, index) => (
          <i key={index} />
        ))}
      </div>
    </div>
  );
}

function LedStrip({ metrics, profile }: { metrics: Metrics; profile: DeviceVisualProfile }) {
  const { t } = useI18n();
  const totalPower = metrics.ports.reduce((sum, port) => sum + watts(port), 0);
  const percent = Math.max(0, Math.min(100, (totalPower / profile.totalPowerBudgetW) * 100));

  return (
    <div
      className="led-assembly"
      aria-label={t("ledStrip")}
      style={{ "--led-strength": `${percent / 100}`, "--led-empty": `${100 - percent}%` } as React.CSSProperties}
    >
      <div className="led-meter" aria-hidden="true">
        {Array.from({ length: 9 }).map((_, index) => (
          <i key={index} />
        ))}
      </div>
      <div className="led-strip">
        <div className="led-fill" />
      </div>
      <strong>FluxAI®</strong>
      <em>{Math.round(percent)}%</em>
    </div>
  );
}

function DeviceFace({
  metrics,
  history,
  profile,
}: {
  metrics: Metrics;
  history: PortHistory;
  profile: DeviceVisualProfile;
}) {
  const { t } = useI18n();
  const frontPorts = profile.frontPortIds
    .map((id) => metrics.ports.find((port) => port.id === id))
    .filter((port): port is PortMetrics => Boolean(port));
  const sidePorts = profile.sidePortIds
    .map((id) => metrics.ports.find((port) => port.id === id))
    .filter((port): port is PortMetrics => Boolean(port));
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageMetrics, setStageMetrics] = useState({ scale: 1, height: 0, width: 0 });
  const assetWidth = 980;

  useEffect(() => {
    const frame = frameRef.current;
    const stage = stageRef.current;
    if (!frame || !stage) {
      return undefined;
    }

    const update = () => {
      const availableWidth = frame.clientWidth;
      const scale = Math.min(1, availableWidth / assetWidth);
      const width = scale < 1 ? assetWidth : availableWidth;
      stage.style.width = `${width}px`;
      setStageMetrics({ scale, height: stage.offsetHeight, width });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [assetWidth, frontPorts.length, profile.key, sidePorts.length]);

  return (
    <section className="device-panel" aria-label={t("deviceFront")}>
      <div
        ref={frameRef}
        className="device-stage-frame"
        style={{
          height: stageMetrics.height ? `${stageMetrics.height * stageMetrics.scale}px` : undefined,
        }}
      >
        <div
          ref={stageRef}
          className={`device-stage ${profile.themeClass} ${sidePorts.length === 0 ? "no-side" : ""}`}
          style={{
            transform: `scale(${stageMetrics.scale})`,
            width: stageMetrics.width ? `${stageMetrics.width}px` : undefined,
          }}
        >
          <div className="device-shell">
            <div className="brand-row">
              <MirrorLogo profile={profile} />
              <CandySignLogo />
            </div>
            <div className="device-main">
              <div className="indicator-slot">
                {profile.displayKind === "amber" ? (
                  <AmberScreen history={history} metrics={metrics} profile={profile} />
                ) : (
                  <LedStrip metrics={metrics} profile={profile} />
                )}
              </div>
              <div className="port-rail" style={{ "--front-ports": frontPorts.length } as React.CSSProperties}>
                <div className="rail-label">{profile.powerLabel}</div>
                {frontPorts.map((port) => (
                  <DevicePort key={port.id} port={port} />
                ))}
              </div>
            </div>
          </div>
          {sidePorts.length > 0 ? (
            <div className="side-port-dock">
              {sidePorts.map((port) => (
                <SidePortFace key={port.id} port={port} profile={profile} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function CandySignLogo() {
  return (
    <svg className="candysign" viewBox="0 0 219 24" aria-label="CANDYSIGN" role="img">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M39.6325 2.76088C36.0914 3.72078 33.3626 6.61411 32.6811 10.2185C32.6566 10.3485 32.4735 10.3462 32.4537 10.2155C31.5884 4.49198 26.59 0.101166 20.5493 0.101166C14.5085 0.101166 9.51007 4.49213 8.64472 10.2156C8.625 10.3464 8.44186 10.3487 8.41732 10.2187C7.73588 6.61426 5.00702 3.72078 1.46594 2.76088C0.749704 2.56682 0.0476074 3.12265 0.0476074 3.85567V20.1114C0.0476074 20.8444 0.749704 21.4004 1.46594 21.2062C5.00702 20.2463 7.73588 17.3528 8.41732 13.7483C8.44186 13.6183 8.625 13.6206 8.64472 13.7514C9.51007 19.4749 14.5085 23.8659 20.5493 23.8659C26.59 23.8659 31.5884 19.4751 32.4537 13.7516C32.4735 13.6208 32.6566 13.6185 32.6811 13.7485C33.3626 17.3529 36.0914 20.2463 39.6325 21.2062C40.3488 21.4004 41.0509 20.8444 41.0509 20.1114V3.85567C41.0509 3.12265 40.3488 2.56682 39.6325 2.76088Z"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M68.3577 14.5929C68.3268 14.6462 68.2807 14.7337 68.2602 14.7727L68.2496 14.7926C66.9301 17.2007 64.1885 18.2839 61.4185 17.4939C59.7922 17.0283 58.4508 15.803 57.8315 14.2167C57.0919 12.3256 57.3102 10.3203 58.4305 8.71668C59.521 7.15338 61.2881 6.2201 63.158 6.2201L63.272 6.22149C65.3073 6.24673 67.1788 7.34148 68.1539 9.07857L68.2585 9.26529C68.2664 9.26236 68.2744 9.25867 68.2831 9.25374C69.2242 8.79026 71.7671 7.55051 72.5132 7.18724L72.4002 6.97974C70.586 3.65718 67.1107 1.56266 63.3307 1.51432L63.1552 1.51294C59.8132 1.51294 56.6323 3.14829 54.6462 5.88777C52.6072 8.70237 52.1141 12.2512 53.2946 15.6229C54.4961 19.055 57.4908 21.5992 61.1105 22.2631C61.7985 22.3892 62.4954 22.4541 63.1805 22.4541C67.1018 22.4541 70.5657 20.4115 72.4466 16.9901L72.5735 16.766L68.3577 14.5929ZM142.736 8.85612L138.321 1.74823L133.012 1.77066L140.482 13.7733V22.6894H144.99V13.7733L152.447 1.77066H147.111L142.736 8.85612ZM175.911 22.4541H171.408V1.74823H175.911V22.4541ZM190.028 14.9582H193.454V16.6975L193.368 16.7637C192.339 17.5572 190.802 17.9762 188.925 17.9762C187.14 17.9762 185.469 17.1828 184.339 15.7991C183.212 14.4177 182.779 12.61 183.15 10.8391C183.563 8.87252 184.998 7.23662 186.894 6.56965C189.404 5.68423 192.132 6.50932 193.691 8.62384L197.415 6.10898C195.434 3.32948 192.228 1.74823 188.888 1.74823C187.937 1.74823 186.973 1.87687 186.025 2.14289C182.094 3.24612 179.111 6.71486 178.602 10.7743C178.226 13.7859 179.122 16.6876 181.126 18.9452C183.104 21.1754 185.947 22.4541 188.925 22.4541C192.64 22.4541 195.584 21.2738 197.438 19.04L197.953 18.4189V10.824H190.028V14.9582ZM99.7259 1.74823L108.348 15.2843V1.76972H113.103V22.4541H107.838L99.3443 9.55616V22.4541H94.6157V1.77555L99.7259 1.74823ZM214.056 15.2843L205.433 1.74823L200.323 1.77555V22.4541H205.051V9.55616L213.546 22.4541H218.81V1.76972H214.056V15.2843ZM82.6464 7.15456L80.2568 13.7706H85.0361L82.6464 7.15456ZM72.3364 22.4225L79.8636 1.74823H85.4292L92.9566 22.4231L88.1235 22.4541L86.3966 17.6038H78.8962L77.2136 22.4225H72.3364ZM161.317 10.2328C159.72 9.64488 157.858 8.7083 157.858 7.52031C157.858 7.0621 158.018 6.66159 158.323 6.36325C158.743 5.94905 159.431 5.74441 160.317 5.75887C162.183 5.78626 163.903 6.4368 165.727 7.80773L168.303 4.30362C166.063 2.60772 163.425 1.74823 160.461 1.74823C157.257 1.74823 152.743 3.42751 152.743 7.1615C152.692 8.65937 152.588 11.7601 158.286 13.8999C158.348 13.9243 159.007 14.1636 159.131 14.2039L159.237 14.2362C160.995 14.7667 163.396 15.4913 163.396 16.7945C163.396 17.2081 163.246 17.5654 162.95 17.8573C162.131 18.6634 160.486 18.6634 160.314 18.6634C158.123 18.636 156.14 17.8256 154.253 16.1864L151.499 19.7447C153.907 21.6265 157.031 22.6438 160.536 22.6877C163.279 22.7231 165.179 22.2122 166.697 21.035C167.865 20.1266 168.493 18.6894 168.564 16.7622C168.518 12.7573 164.371 11.3048 161.892 10.4374L161.844 10.4205C161.655 10.3541 161.478 10.2919 161.317 10.2328ZM125.292 18.4017C126.071 18.4017 127.45 18.2294 128.551 17.1685C129.595 16.162 130.138 14.6 130.164 12.5268C130.221 8.04956 128.444 5.94196 124.57 5.89306L121.215 5.85503V18.3544L125.203 18.4017H125.292ZM116.421 1.74823L125.726 1.86015C131.468 1.9319 134.986 5.8788 134.907 12.1593C134.824 18.6056 131.356 22.4541 125.628 22.4541L116.421 22.3414V1.74823Z"
      />
    </svg>
  );
}

function MirrorLogo({ profile }: { profile: DeviceVisualProfile }) {
  if (profile.family === "CP02") {
    return (
      <div className={`cp02-logo ${profile.variant}`}>
        <span>CP-02</span>
        <i />
        <strong>160W GaN</strong>
        <em>CoCan <b>{profile.variant === "ultra" ? "Ultra" : "Pro"}</b></em>
      </div>
    );
  }

  return (
    <div className={`mirror-logo badge-${profile.badgeStyle}`}>
      <span>CoCan</span>
      <strong>Mirror</strong>
      <em>{profile.variant === "ultra" ? "Ultra" : "Pro"}</em>
    </div>
  );
}

function DevicePort({ port }: { port: PortMetrics }) {
  const isA = port.port_type === "A";

  return (
    <div className={`device-port ${isA ? "type-a" : "type-c"} ${port.attached ? "attached" : ""}`}>
      <div className="port-hole">
        <span />
      </div>
      <strong>{portLabel(port)}</strong>
      <small>{watts(port).toFixed(1)}W</small>
    </div>
  );
}

function SidePortFace({ port, profile }: { port: PortMetrics; profile: DeviceVisualProfile }) {
  const { t } = useI18n();
  return (
    <aside className="side-port-face" aria-label={t("sideC4")}>
      <div className="side-seam" />
      <div className="side-brand">{profile.sidePortLabel}</div>
      <DevicePort port={port} />
      <div className="side-caption">SIDE PORT</div>
    </aside>
  );
}

function PortCard({ port }: { port: PortMetrics }) {
  const { t } = useI18n();
  return (
    <article className={`port-card ${temperatureLevel(port.die_temperature)} ${port.id === 4 ? "side-card" : ""}`}>
      <div className="port-card-top">
        <div>
          <p>{port.id === 4 ? `USB-C · ${t("sideSuffix")}` : port.port_type === "A" ? "USB-A" : "USB-C"}</p>
          <h2>{portLabel(port)}</h2>
        </div>
        <span className="state-dot">{port.attached ? t("attached") : t("idle")}</span>
      </div>
      <div className="power-number">{watts(port).toFixed(1)}W</div>
      <div className="port-grid">
        <span>{volts(port.voltage).toFixed(2)}V</span>
        <span>{amps(port.current).toFixed(2)}A</span>
        <span>{port.die_temperature}C</span>
        <span>{protocolName(port.fc_protocol)}</span>
      </div>
      <div className="budget-row">
        <span>{t("portLimit")} {port.power_budget}W</span>
        <span>{formatDuration(port.charging_duration_seconds)}</span>
      </div>
    </article>
  );
}

function SummaryStrip({
  metrics,
  heap,
  profile,
}: {
  metrics: Metrics;
  heap: HeapMetrics;
  profile: DeviceVisualProfile;
}) {
  const { t } = useI18n();
  const totalPower = metrics.ports.reduce((sum, port) => sum + watts(port), 0);
  const heapUsed = heap.total_allocated / (heap.total_allocated + heap.total_free);

  return (
    <section className="summary-strip">
      <SummaryItem icon={<Zap size={18} />} label={t("totalPower")} value={`${totalPower.toFixed(1)}W`} detail={`${profile.totalPowerBudgetW}W ${t("modelMax")}`} />
      <SummaryItem icon={<Gauge size={18} />} label={t("thermalPeak")} value={`${Math.max(...metrics.ports.map((p) => p.die_temperature))}C`} detail={t("thermalDetail")} />
      <SummaryItem icon={<HardDrive size={18} />} label={t("heapUsed")} value={`${Math.round(heapUsed * 100)}%`} detail={`${Math.round(heap.total_free / 1024)}KB ${t("available")}`} />
      <SummaryItem icon={<Cpu size={18} />} label={t("runtime")} value={`${Math.floor(metrics.system.boot_time_seconds / 60)}m`} detail={metrics.system.app_version} />
    </section>
  );
}

function DiagnosticsDeck({
  metrics,
  heap,
  history,
  machineInfo,
}: {
  metrics: Metrics;
  heap: HeapMetrics;
  history: PortHistory;
  machineInfo: MachineInfo;
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = React.useState<"info" | "heap" | "ports">("ports");
  const [selectedPortId, setSelectedPortId] = React.useState<number | null>(null);
  const selectedPort = selectedPortId == null
    ? null
    : metrics.ports.find((port) => port.id === selectedPortId) ?? null;

  return (
    <section className="diagnostics-deck" aria-label={t("diagnosticsAria")}>
      <div className="diagnostics-head">
        <div>
          <p>{t("diagnostics")}</p>
          <h2>{t("diagnosticsTitle")}</h2>
        </div>
        <nav className="diagnostics-tabs" aria-label={t("diagnosticsTabs")}>
          {[
            ["info", t("tabDevice")],
            ["heap", t("tabHeap")],
            ["ports", t("tabPorts")],
          ].map(([key, label]) => (
            <button
              aria-selected={activeTab === key}
              className={activeTab === key ? "active" : ""}
              key={key}
              onClick={() => setActiveTab(key as "info" | "heap" | "ports")}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="diagnostics-tab-panel" role="tabpanel">
        {activeTab === "info" ? <MachineInfoCard machineInfo={machineInfo} /> : null}
        {activeTab === "heap" ? <HeapCard heap={heap} /> : null}
        {activeTab === "ports" ? (
          <PortHistoryExplorer
            history={history}
            ports={metrics.ports}
            selectedPort={selectedPort}
            selectedPortId={selectedPortId}
            onSelectPort={setSelectedPortId}
          />
        ) : null}
      </div>
    </section>
  );
}

function MachineInfoCard({ machineInfo }: { machineInfo: MachineInfo }) {
  const { t } = useI18n();
  const rows = [
    ["PSN", machineInfo.psn],
    [t("deviceModel"), machineInfo.device_model],
    [t("deviceName"), machineInfo.device_name],
    [t("productFamily"), machineInfo.product_family],
    [t("productColor"), machineInfo.product_color],
    [t("hwRev"), machineInfo.hw_rev],
    ["BLE MAC", machineInfo.ble_mac],
    ["Wi-Fi MAC", machineInfo.wifi_mac],
    ["ESP32", machineInfo.esp32_version],
    ["MCU", machineInfo.mcu_version],
    ["FPGA", machineInfo.fpga_version],
    ["ZRLib", machineInfo.zrlib_version],
    [t("country"), machineInfo.country_code],
    ["mDNS", `${machineInfo.mdns_hostname}.local`],
  ];

  return (
    <article className="diagnostic-card machine-info-card" id="info">
      <div className="diagnostic-title">
        <p>{t("tabDevice")}</p>
        <h3>{t("machineInfo")}</h3>
      </div>
      <dl className="machine-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function HeapCard({ heap }: { heap: HeapMetrics }) {
  const { t } = useI18n();
  const total = heap.total_allocated + heap.total_free;
  const usedPercent = total > 0 ? Math.round((heap.total_allocated / total) * 100) : 0;
  const rows = [
    [t("heapFree"), kilobytes(heap.total_free)],
    [t("heapAllocated"), kilobytes(heap.total_allocated)],
    [t("heapLargestFree"), kilobytes(heap.largest_free_block)],
    [t("heapMinFree"), kilobytes(heap.min_free)],
    [t("heapAllocatedBlocks"), heap.allocated_blocks.toString()],
    [t("heapFreeBlocks"), heap.free_blocks.toString()],
    [t("heapTotalBlocks"), heap.total_blocks.toString()],
  ];

  return (
    <article className="diagnostic-card heap-card" id="heap">
      <div className="diagnostic-title">
        <p>{t("tabHeap")}</p>
        <h3>{t("heapStatus")}</h3>
      </div>
      <div className="heap-ring" style={{ "--heap": `${usedPercent}%` } as React.CSSProperties}>
        <strong>{usedPercent}%</strong>
        <span>{t("heapUsedShort")}</span>
      </div>
      <dl className="machine-list compact">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function PortHistoryExplorer({
  ports,
  history,
  selectedPort,
  selectedPortId,
  onSelectPort,
}: {
  ports: PortMetrics[];
  history: PortHistory;
  selectedPort: PortMetrics | null;
  selectedPortId: number | null;
  onSelectPort: (id: number | null) => void;
}) {
  const { t } = useI18n();
  const selectedSamples = selectedPort ? getPortSamples(history, selectedPort.id) : [];
  const selectedSeries = selectedSamples.map((sample, index) => ({
    time: formatSampleTime(sample.ts, selectedSamples.length, index, history.sample_period_ms),
    power: samplePower(sample),
    temperature: validTemperature(sample.temperature_c) ?? validTemperature(selectedPort?.die_temperature),
    voltage: volts(sample.voltage),
    current: amps(sample.current),
  }));
  const powers = selectedSeries.map((sample) => sample.power);
  const min = powers.length > 0 ? Math.min(...powers) : 0;
  const max = powers.length > 0 ? Math.max(...powers) : 0;
  const avg = powers.reduce((sum, power) => sum + power, 0) / Math.max(powers.length, 1);
  const coverage = getHistoryCoverageLabel(history, t);

  return (
    <article className="diagnostic-card port-history-card" id="ports">
      <div className="diagnostic-title split-title">
        <div>
          <p>{t("tabPorts")}</p>
          <h3>{t("perPortHistory")}</h3>
        </div>
        <span>{coverage}</span>
      </div>
      <div className="port-history-grid">
        {ports.map((port) => {
          const samples = getPortSamples(history, port.id);
          return (
            <button
              className={port.id === selectedPortId ? "active" : ""}
              key={port.id}
              onClick={() => onSelectPort(port.id === selectedPortId ? null : port.id)}
              type="button"
            >
              <div className="mini-port-head">
                <strong>{portLabel(port)}</strong>
                <span />
              </div>
              <p>{port.id === 4 ? `USB-C · ${t("sideSuffix")}` : port.port_type === "A" ? "USB-A" : "USB-C"}</p>
              <div className="mono-line">
                {volts(port.voltage).toFixed(3)}V&nbsp;&nbsp;{amps(port.current).toFixed(3)}A
              </div>
              <div className="mini-power">{watts(port).toFixed(3)}W</div>
              <Sparkline samples={samples.map(samplePower)} />
              <div className="mini-footer">
                <span>{t("powerTrend")}</span>
                <strong>{watts(port).toFixed(1)}W</strong>
              </div>
            </button>
          );
        })}
      </div>

      {selectedPort ? <div className="port-detail-panel">
        <div className="port-detail-head">
          <div>
            <p>{t("selected")}</p>
            <h3>{portLabel(selectedPort)}</h3>
          </div>
          <span>
            {portLabel(selectedPort)} · {protocolName(selectedPort.fc_protocol)}
            {selectedPort.id === 4 ? ` · ${t("sideSuffix")}` : ""}
          </span>
        </div>
        <ResponsiveContainer width="100%" height={230}>
          <ComposedChart data={selectedSeries} margin={{ top: 12, right: 18, left: -22, bottom: 0 }}>
            <defs>
              <linearGradient id="portDetailFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f47b20" stopOpacity={0.36} />
                <stop offset="100%" stopColor="#f47b20" stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#ded6cb" vertical />
            <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
            <YAxis yAxisId="power" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
            <YAxis
              yAxisId="temperature"
              orientation="right"
              tickLine={false}
              axisLine={false}
              tick={{ fill: "#9c4f22", fontSize: 12 }}
            />
            <Tooltip formatter={(value, name) => name === "temperature" ? formatTemperatureTooltip(value) : `${Number(value).toFixed(2)}W`} />
            <Area
              dataKey="power"
              dot={false}
              fill="url(#portDetailFill)"
              isAnimationActive={false}
              stroke="#f47b20"
              strokeWidth={2.5}
              type="monotone"
              yAxisId="power"
            />
            <Line
              connectNulls
              dataKey="temperature"
              dot={false}
              isAnimationActive={false}
              name="temperature"
              stroke="#7f6d52"
              strokeDasharray="4 4"
              strokeWidth={2}
              type="monotone"
              yAxisId="temperature"
            />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="trend-stats">
          <span>{t("min")} {min.toFixed(2)}W</span>
          <span>{t("avg")} {avg.toFixed(2)}W</span>
          <span>{t("max")} {max.toFixed(2)}W</span>
        </div>
        <div className="port-detail-lists">
          <dl>
            <div>
              <dt>{t("state")}</dt>
              <dd>{selectedPort.state}</dd>
            </div>
            <div>
              <dt>{t("protocol")}</dt>
              <dd>{protocolName(selectedPort.fc_protocol)} · {selectedPort.fc_protocol}</dd>
            </div>
            <div>
              <dt>{t("voltage")}</dt>
              <dd>{volts(selectedPort.voltage).toFixed(3)}V</dd>
            </div>
            <div>
              <dt>{t("current")}</dt>
              <dd>{amps(selectedPort.current).toFixed(3)}A</dd>
            </div>
            <div>
              <dt>{t("power")}</dt>
              <dd>{watts(selectedPort).toFixed(3)}W</dd>
            </div>
            <div>
              <dt>{t("session")}</dt>
              <dd>{formatDuration(selectedPort.charging_duration_seconds)}</dd>
            </div>
            <div>
              <dt>{t("sessionCharge")}</dt>
              <dd>{milliwattHours(selectedPort.session_charge)}</dd>
            </div>
          </dl>
          <dl>
            <div>
              <dt>{t("portLimit")}</dt>
              <dd>{selectedPort.power_budget}W</dd>
            </div>
            <div>
              <dt>{t("portTemp")}</dt>
              <dd>{selectedPort.die_temperature}C</dd>
            </div>
            <div>
              <dt>VIN</dt>
              <dd>{volts(selectedPort.vin_value).toFixed(2)}V</dd>
            </div>
            <div>
              <dt>{t("sessionId")}</dt>
              <dd>{selectedPort.session_id}</dd>
            </div>
            <div>
              <dt>{t("pdStatus")}</dt>
              <dd>{selectedPort.pd_status ? t("pdAvailable") : t("noPdData")}</dd>
            </div>
          </dl>
        </div>
      </div> : (
        <div className="collapsed-hint">
          <span>{t("collapsed")}</span>
          <strong>{t("collapsedHint")}</strong>
        </div>
      )}
    </article>
  );
}

function Sparkline({ samples }: { samples: number[] }) {
  const { t } = useI18n();
  const width = 180;
  const height = 58;
  if (samples.length === 0) {
    return (
      <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("powerTrend")}>
        <line x1="0" x2={width} y1="42" y2="42" />
      </svg>
    );
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = Math.max(max - min, 0.01);
  const points = samples
    .map((value, index) => {
      const x = (index / Math.max(samples.length - 1, 1)) * width;
      const y = height - ((value - min) / range) * (height - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("powerTrend")}>
      <line x1="0" x2={width} y1="18" y2="18" />
      <line x1="0" x2={width} y1="42" y2="42" />
      <polyline points={points} />
    </svg>
  );
}

function getPortSamples(history: PortHistory, portId: number) {
  return history.ports.find((port) => port.port === portId)?.samples ?? [];
}

function samplePower(sample: { voltage: number; current: number }) {
  return (sample.voltage * sample.current) / 1_000_000;
}

function validTemperature(value: number | undefined | null) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}

function maxValidTemperature(values: Array<number | null | undefined>) {
  const valid = values.map(validTemperature).filter((value): value is number => value != null);
  return valid.length > 0 ? Math.max(...valid) : null;
}

function formatTemperatureTooltip(value: unknown) {
  return typeof value === "number" && value > 0 ? `${value.toFixed(0)}C` : "N/A";
}

function getHistoryCoverageLabel(history: PortHistory, t: (key: TranslationKey) => string) {
  const samples = Math.max(...history.ports.map((port) => port.samples.length), 0);
  const minutes = Math.round((samples * history.sample_period_ms) / 60000);
  if (minutes >= 60) return t("local60m");
  if (minutes > 0) return `${t("deviceMinutesPrefix")} ${minutes}${t("deviceMinutesSuffix")}`;
  return t("waitingSamples");
}

function formatSampleTime(
  ts: number | undefined,
  sampleCount: number,
  index: number,
  samplePeriodMs: number,
) {
  if (Number.isFinite(ts)) {
    return new Date(ts as number).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  return `${Math.round(((sampleCount - index - 1) * samplePeriodMs) / 60000)}m`;
}

function SummaryItem({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="summary-item">
      <div className="summary-icon">{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function ProfileSwitcher({
  activeProfile,
  detectedProfile,
  onChange,
}: {
  activeProfile: DeviceVisualProfile;
  detectedProfile: DeviceVisualProfile;
  onChange: (profile: DeviceVisualProfile) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="profile-switcher" aria-label={t("profileSwitchAria")}>
      <div>
        <p>{t("appearancePreview")}</p>
        <h2>{t("appearanceProfile")}</h2>
      </div>
      <div className="profile-options">
        {deviceProfiles.map((profile) => (
          <button
            className={profile.key === activeProfile.key ? "active" : ""}
            key={profile.key}
            onClick={() => onChange(profile)}
            type="button"
          >
            <span>{profile.family}</span>
            <strong>{profile.variant.toUpperCase()}</strong>
            {profile.key === detectedProfile.key ? <em>{t("detected")}</em> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function LongHistoryPanel({
  targetUrl,
  metrics,
  ports,
  updatedAt,
}: {
  targetUrl: string;
  metrics: Metrics;
  ports: PortMetrics[];
  updatedAt: Date | null;
}) {
  const { t } = useI18n();
  const now = React.useMemo(() => new Date(), []);
  const [hours, setHours] = React.useState(24);
  const [rangeMode, setRangeMode] = React.useState<"preset" | "custom">("preset");
  const [customStart, setCustomStart] = React.useState(formatDateTimeLocal(new Date(now.getTime() - 24 * 60 * 60 * 1000)));
  const [customEnd, setCustomEnd] = React.useState(formatDateTimeLocal(now));
  const [portFilter, setPortFilter] = React.useState<number | null>(null);
  const [rows, setRows] = React.useState<ServerHistoryRow[]>([]);
  const [status, setStatus] = React.useState<"loading" | "ready" | "empty" | "unavailable">("loading");
  const [loadedAt, setLoadedAt] = React.useState<Date | null>(null);
  const start = rangeMode === "custom" ? parseDateTimeLocal(customStart) : undefined;
  const end = rangeMode === "custom" ? parseDateTimeLocal(customEnd) : undefined;
  const canQuery = rangeMode === "preset" || (start != null && end != null && start <= end);

  React.useEffect(() => {
    let alive = true;
    if (!canQuery) {
      setRows([]);
      setLoadedAt(null);
      setStatus("empty");
      return () => {
        alive = false;
      };
    }
    setStatus("loading");
    fetchServerHistory({
      targetUrl,
      hours: rangeMode === "preset" ? hours : undefined,
      start,
      end,
      port: portFilter,
    })
      .then((nextRows) => {
        if (!alive) return;
        setRows(nextRows);
        setLoadedAt(new Date());
        setStatus(nextRows.length > 0 ? "ready" : "empty");
      })
      .catch(() => {
        if (!alive) return;
        setRows([]);
        setLoadedAt(null);
        setStatus("unavailable");
      });
    return () => {
      alive = false;
    };
  }, [targetUrl, hours, rangeMode, customStart, customEnd, portFilter, canQuery, start, end]);

  React.useEffect(() => {
    if (!updatedAt || !canQuery) return;
    const ts = updatedAt.getTime();
    const rangeStart = rangeMode === "custom" ? start : Date.now() - hours * 60 * 60 * 1000;
    const rangeEnd = rangeMode === "custom" ? end : Date.now() + 1000;
    if (rangeStart == null || rangeEnd == null || ts < rangeStart || ts > rangeEnd) return;
    const nextLiveRows = metrics.ports
      .filter((port) => portFilter == null || port.id === portFilter)
      .map((port) => ({
        ts,
        target: targetUrl,
        port: port.id,
        voltage: port.voltage,
        current: port.current,
        temperature_c: port.die_temperature,
        power_w: watts(port),
        attached: port.attached,
        protocol: String(port.fc_protocol),
      }));
    setRows((currentRows) => {
      const merged = [...currentRows.filter((row) => row.ts >= rangeStart && row.ts <= rangeEnd), ...nextLiveRows];
      const bySample = new Map<string, ServerHistoryRow>();
      for (const row of merged) bySample.set(`${row.ts}:${row.port}`, row);
      return Array.from(bySample.values()).sort((a, b) => a.ts - b.ts || a.port - b.port);
    });
    setLoadedAt(new Date());
    setStatus((currentStatus) => currentStatus === "unavailable" ? currentStatus : "ready");
  }, [targetUrl, metrics, hours, rangeMode, portFilter, updatedAt, canQuery, start, end]);

  const chartRows = React.useMemo(() => buildServerHistoryChartRows(rows), [rows]);
  const powerValues = chartRows.map((row) => row.power);
  const avgPower = powerValues.reduce((sum, value) => sum + value, 0) / Math.max(powerValues.length, 1);
  const maxPower = powerValues.length > 0 ? Math.max(...powerValues) : 0;
  const maxTemp = maxValidTemperature(chartRows.map((row) => row.temperature));

  return (
    <section className="panel long-history-panel" id="history">
      <div className="panel-header long-history-head">
        <div>
          <p>{t("serverHistory")}</p>
          <h2>{t("longHistory")}</h2>
          <span className="panel-note">
            {t("autoRefreshPrefix")}{loadedAt ? ` · ${loadedAt.toLocaleTimeString("zh-CN", { hour12: false })}` : ""}
          </span>
        </div>
        <div className="history-filters" aria-label={t("historyFilters")}>
          <label>
            <Filter size={15} />
            <select value={rangeMode} onChange={(event) => setRangeMode(event.target.value as "preset" | "custom")}>
              <option value="preset">{t("preset")}</option>
              <option value="custom">{t("custom")}</option>
            </select>
          </label>
          {rangeMode === "preset" ? <label>
            <select value={hours} onChange={(event) => setHours(Number(event.target.value))}>
              <option value={1}>1h</option>
              <option value={6}>6h</option>
              <option value={24}>24h</option>
              <option value={168}>7d</option>
              <option value={720}>30d</option>
            </select>
          </label> : <>
            <label className="datetime-filter">
              <span>{t("from")}</span>
              <input type="datetime-local" value={customStart} onChange={(event) => setCustomStart(event.target.value)} />
            </label>
            <label className="datetime-filter">
              <span>{t("to")}</span>
              <input type="datetime-local" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} />
            </label>
          </>}
          <label>
            <Database size={15} />
            <select
              value={portFilter ?? "all"}
              onChange={(event) => setPortFilter(event.target.value === "all" ? null : Number(event.target.value))}
            >
              <option value="all">{t("allPorts")}</option>
              {ports.map((port) => (
                <option key={port.id} value={port.id}>
                  {port.id === 4 ? `C4 ${t("sideSuffix")}` : portLabel(port)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {status === "ready" ? (
        <>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={chartRows} margin={{ top: 10, right: 12, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="serverHistoryFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f47b20" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#f47b20" stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#e6dfd4" vertical={false} />
              <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
              <YAxis yAxisId="power" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
              <YAxis
                yAxisId="temperature"
                orientation="right"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "#9c4f22", fontSize: 12 }}
              />
              <Tooltip
                contentStyle={{ border: "1px solid #2e2823", borderRadius: 8 }}
                formatter={(value, name) => name === "temperature" ? formatTemperatureTooltip(value) : `${Number(value).toFixed(2)}W`}
              />
              <Area
                dataKey="power"
                dot={false}
                fill="url(#serverHistoryFill)"
                isAnimationActive={false}
                stroke="#f47b20"
                strokeWidth={2.5}
                type="monotone"
                yAxisId="power"
              />
              <Line
                connectNulls
                dataKey="temperature"
                dot={false}
                isAnimationActive={false}
                name="temperature"
                stroke="#7f6d52"
                strokeDasharray="5 5"
                strokeWidth={2}
                type="monotone"
                yAxisId="temperature"
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="history-stats">
            <span>{t("samples")} {rows.length}</span>
            <span>{t("avg")} {avgPower.toFixed(2)}W</span>
            <span>{t("max")} {maxPower.toFixed(2)}W</span>
            <span>{t("highestTemp")} {maxTemp == null ? "N/A" : `${maxTemp.toFixed(0)}C`}</span>
          </div>
        </>
      ) : (
        <div className="history-empty">
          <strong>
            {status === "loading"
              ? t("readingHistory")
              : !canQuery
                ? t("invalidRange")
              : status === "empty"
                ? t("emptyHistory")
                : t("unavailableHistory")}
          </strong>
          <span>{t("sqliteHint")}</span>
        </div>
      )}
    </section>
  );
}

function formatDateTimeLocal(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDateTimeLocal(value: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function buildServerHistoryChartRows(rows: ServerHistoryRow[]) {
  const bucketMs = chooseHistoryBucketMs(rows);
  const buckets = new Map<number, Map<number, { power: number; temperature: number | null }>>();
  for (const row of rows) {
    const bucket = Math.floor(row.ts / bucketMs) * bucketMs;
    const timeline = buckets.get(bucket) ?? new Map<number, { power: number; temperature: number | null }>();
    const existing = timeline.get(row.ts) ?? { power: 0, temperature: null };
    const temperature = validTemperature(row.temperature_c);
    existing.power += row.power_w;
    existing.temperature = temperature == null
      ? existing.temperature
      : Math.max(existing.temperature ?? temperature, temperature);
    timeline.set(row.ts, existing);
    buckets.set(bucket, timeline);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([ts, timeline]) => {
      const values = Array.from(timeline.values());
      return {
        time: new Date(ts).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }),
        power: values.reduce((sum, value) => sum + value.power, 0) / Math.max(values.length, 1),
        temperature: maxValidTemperature(values.map((value) => value.temperature)),
      };
    });
}

function chooseHistoryBucketMs(rows: ServerHistoryRow[]) {
  if (rows.length < 2) return 60 * 1000;
  const span = rows[rows.length - 1].ts - rows[0].ts;
  if (span > 7 * 24 * 60 * 60 * 1000) return 60 * 60 * 1000;
  if (span > 24 * 60 * 60 * 1000) return 15 * 60 * 1000;
  if (span > 6 * 60 * 60 * 1000) return 5 * 60 * 1000;
  return 60 * 1000;
}

function PowerChart({ history }: { history: PortHistory }) {
  const { t } = useI18n();
  const basePort = history.ports.reduce(
    (longest, port) => (port.samples.length > longest.samples.length ? port : longest),
    history.ports[0],
  );
  const rows = basePort?.samples.map((_, sampleIndex) => {
    const row: Record<string, number | string | null> = {
      time: formatSampleTime(
        basePort.samples[sampleIndex]?.ts,
        basePort.samples.length,
        sampleIndex,
        history.sample_period_ms,
      ),
    };

    for (const port of history.ports) {
      const sample = port.samples[sampleIndex];
      row[port.port === 0 ? "A" : `C${port.port}`] = sample ? samplePower(sample) : 0;
    }
    row.temperature = maxValidTemperature(history.ports.map((port) => port.samples[sampleIndex]?.temperature_c));

    return row;
  }) ?? [];

  return (
    <section className="panel chart-panel">
      <div className="panel-header">
        <div>
          <p>{t("portTimeline")}</p>
          <h2>{t("livePowerAndTemp")}</h2>
          <span className="panel-note">{getHistoryCoverageLabel(history, t)}</span>
        </div>
        <Activity size={20} />
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={rows} margin={{ top: 12, right: 12, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="amberFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f47b20" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#f47b20" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#e6dfd4" vertical={false} />
          <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
          <YAxis yAxisId="power" tickLine={false} axisLine={false} tick={{ fill: "#766b5f", fontSize: 12 }} />
          <YAxis
            yAxisId="temperature"
            orientation="right"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#9c4f22", fontSize: 12 }}
          />
          <Tooltip
            contentStyle={{ border: "1px solid #2e2823", borderRadius: 8 }}
            formatter={(value, name) => name === "temperature" ? formatTemperatureTooltip(value) : `${Number(value).toFixed(1)}W`}
          />
          {["A", "C1", "C2", "C3", "C4"].map((key, index) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={["#2b2926", "#f47b20", "#d9571c", "#917a54", "#6d9483"][index]}
              fill={index === 1 ? "url(#amberFill)" : "transparent"}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              yAxisId="power"
            />
          ))}
          <Line
            connectNulls
            dataKey="temperature"
            dot={false}
            isAnimationActive={false}
            name="temperature"
            stroke="#7f6d52"
            strokeDasharray="5 5"
            strokeWidth={2}
            type="monotone"
            yAxisId="temperature"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </section>
  );
}

function TaskPanel({ tasks }: { tasks: TaskMetrics[] }) {
  const { t } = useI18n();
  return (
    <section className="panel task-panel">
      <div className="panel-header">
        <div>
          <p>{t("runtime")}</p>
          <h2>{t("taskLoad")}</h2>
        </div>
        <Cpu size={20} />
      </div>
      <div className="task-list">
        {tasks
          .slice()
          .sort((a, b) => b.cpu_percent - a.cpu_percent)
          .map((task) => (
            <div className="task-row" key={task.name}>
              <span>{task.name}</span>
              <div className="bar">
                <i style={{ width: `${Math.min(task.cpu_percent, 100)}%` }} />
              </div>
              <strong>{task.cpu_percent.toFixed(2)}%</strong>
            </div>
          ))}
      </div>
    </section>
  );
}

function SystemPanel({ metrics, heap }: { metrics: Metrics; heap: HeapMetrics }) {
  const { t } = useI18n();
  return (
    <section className="panel system-panel">
      <div className="panel-header">
        <div>
          <p>{t("tabDevice")}</p>
          <h2>{t("systemStatus")}</h2>
        </div>
        <RefreshCw size={20} />
      </div>
      <dl>
        <div>
          <dt>Chip</dt>
          <dd>{metrics.system.chip} · {metrics.system.cpu_freq_mhz}MHz</dd>
        </div>
        <div>
          <dt>IDF</dt>
          <dd>{metrics.system.idf_version}</dd>
        </div>
        <div>
          <dt>Wi-Fi</dt>
          <dd>{metrics.wifi.ssid} · ch {metrics.wifi.channel}</dd>
        </div>
        <div>
          <dt>BSSID</dt>
          <dd>{metrics.wifi.bssid}</dd>
        </div>
        <div>
          <dt>{t("tabHeap")}</dt>
          <dd>{Math.round(heap.total_free / 1024)}KB {t("available")} · {heap.allocated_blocks} blocks</dd>
        </div>
      </dl>
    </section>
  );
}

function RuntimePanel({ metrics, heap }: { metrics: Metrics; heap: HeapMetrics }) {
  return (
    <section className="panel runtime-panel">
      <SystemPanel metrics={metrics} heap={heap} />
      <TaskPanel tasks={metrics.tasks} />
    </section>
  );
}

function App() {
  const [language, setLanguageState] = React.useState<Language>(readLanguage);
  const [targetUrl, setTargetUrl] = React.useState(readDeviceTarget);
  const [refreshIntervalMs, setRefreshIntervalMs] = React.useState(readRefreshInterval);
  const [showAppearanceSwitcher, setShowAppearanceSwitcher] = React.useState(false);
  const [savedTargets, setSavedTargets] = React.useState<SavedTarget[]>([]);
  const { ready, passwordRequired, serverSession, setPasswordRequired, setServerSession } = useServerSettings();
  const [activeProfileKey, setActiveProfileKey] = React.useState<string | null>(null);
  const [connectionActionPending, setConnectionActionPending] = React.useState(false);
  const connectionActionPendingRef = React.useRef(false);
  const handleLiveConfigUpdate = React.useCallback((nextConfig: ServerSession["config"]) => {
    setSavedTargets(nextConfig.targets);
    setShowAppearanceSwitcher(Boolean(nextConfig.showAppearanceSwitcher));
  }, []);
  const liveEnabled = ready && !passwordRequired;
  const { data, transportState, updatedAt, retry } = useDashboardData(
    targetUrl,
    refreshIntervalMs,
    liveEnabled,
    handleLiveConfigUpdate,
  );
  const i18n = React.useMemo(() => ({
    language,
    setLanguage: (nextLanguage: Language) => {
      setLanguageState(nextLanguage);
      writeLanguage(nextLanguage);
    },
    t: (key: TranslationKey) => translate(language, key),
  }), [language]);

  async function runConnectionAction(action: () => Promise<void>) {
    if (connectionActionPendingRef.current) return;
    connectionActionPendingRef.current = true;
    setConnectionActionPending(true);
    try {
      await action();
    } finally {
      connectionActionPendingRef.current = false;
      setConnectionActionPending(false);
    }
  }

  async function handleConnectionSettingsApply(nextTargetUrl: string, nextRefreshIntervalMs: number, note: string) {
    await runConnectionAction(async () => {
      const clamped = clampRefreshInterval(nextRefreshIntervalMs);
      const saved = await saveServerConfig({ targetUrl: nextTargetUrl, refreshIntervalMs: clamped, note });
      const savedTarget = normalizeDeviceTarget(saved.targetUrl);
      const savedInterval = clampRefreshInterval(saved.refreshIntervalMs);
      setActiveProfileKey(null);
      setSavedTargets(saved.targets);
      setTargetUrl(savedTarget);
      setRefreshIntervalMs(savedInterval);
      writeDeviceTarget(savedTarget);
      writeRefreshInterval(savedInterval);
      retry();
    });
  }

  async function handleSavedTargetNoteUpdate(target: SavedTarget, note: string) {
    await runConnectionAction(async () => {
      const saved = await updateSavedTargetNote({ targetUrl: target.targetUrl, deviceKey: target.deviceKey, note });
      setSavedTargets(saved.targets);
    });
  }

  async function handleSavedTargetSelect(target: SavedTarget) {
    await runConnectionAction(async () => {
      const saved = await setActiveServerTarget(target.targetUrl);
      const savedTarget = normalizeDeviceTarget(saved.targetUrl);
      const savedInterval = clampRefreshInterval(saved.refreshIntervalMs);
      setActiveProfileKey(null);
      setSavedTargets(saved.targets);
      setTargetUrl(savedTarget);
      setRefreshIntervalMs(savedInterval);
      writeDeviceTarget(savedTarget);
      writeRefreshInterval(savedInterval);
      retry();
    });
  }

  async function handleDeleteSavedTarget(targetToDelete: string) {
    await runConnectionAction(async () => {
      const saved = await deleteSavedTarget(targetToDelete);
      setSavedTargets(saved.targets);
      if (saved.targetUrl) {
        const nextTarget = normalizeDeviceTarget(saved.targetUrl);
        const nextInterval = clampRefreshInterval(saved.refreshIntervalMs);
        setTargetUrl(nextTarget);
        setRefreshIntervalMs(nextInterval);
        writeDeviceTarget(nextTarget);
        writeRefreshInterval(nextInterval);
      } else {
        setTargetUrl("");
        writeDeviceTarget("");
      }
      retry();
    });
  }

  React.useEffect(() => {
    if (!serverSession || !serverSession.authenticated) return;
    const serverInterval = clampRefreshInterval(serverSession.config.refreshIntervalMs);
    setSavedTargets(serverSession.config.targets);
    setShowAppearanceSwitcher(Boolean(serverSession.config.showAppearanceSwitcher));
    setRefreshIntervalMs(serverInterval);
    writeRefreshInterval(serverInterval);
    if (serverSession.config.targetUrl) {
      const serverTarget = normalizeDeviceTarget(serverSession.config.targetUrl);
      setTargetUrl(serverTarget);
      writeDeviceTarget(serverTarget);
    } else {
      setTargetUrl("");
      writeDeviceTarget("");
    }
  }, [serverSession]);

  if (!ready) {
    return (
      <I18nContext.Provider value={i18n}>
        <main className="loading">{i18n.t("loading")}</main>
      </I18nContext.Provider>
    );
  }

  if (passwordRequired) {
    return (
      <I18nContext.Provider value={i18n}>
        <LoginScreen
          onLogin={(session) => {
            setServerSession(session);
            setPasswordRequired(false);
          }}
        />
      </I18nContext.Provider>
    );
  }

  if (!data) {
    return (
      <I18nContext.Provider value={i18n}>
        <TargetSetupScreen
          refreshIntervalMs={refreshIntervalMs}
          state={targetUrl.trim() ? "connecting" : "offline"}
          targetUrl={targetUrl}
          savedTargets={savedTargets}
          connectionActionPending={connectionActionPending}
          onApply={handleConnectionSettingsApply}
          onSelectSavedTarget={handleSavedTargetSelect}
          onDeleteTarget={handleDeleteSavedTarget}
          onUpdateTargetNote={handleSavedTargetNoteUpdate}
        />
      </I18nContext.Provider>
    );
  }

  const { metrics, history, heap, machineInfo, source } = data;
  if (source === "mock") {
    return (
      <I18nContext.Provider value={i18n}>
        <TargetSetupScreen
          refreshIntervalMs={refreshIntervalMs}
          targetUrl={targetUrl}
          savedTargets={savedTargets}
          connectionActionPending={connectionActionPending}
          onApply={handleConnectionSettingsApply}
          onSelectSavedTarget={handleSavedTargetSelect}
          onDeleteTarget={handleDeleteSavedTarget}
          onUpdateTargetNote={handleSavedTargetNoteUpdate}
        />
      </I18nContext.Provider>
    );
  }

  const detectedProfile = resolveDeviceProfile(machineInfo, metrics.ports);
  const activeProfile =
    deviceProfiles.find((profile) => profile.key === (showAppearanceSwitcher ? activeProfileKey ?? detectedProfile.key : detectedProfile.key)) ??
    detectedProfile;

  return (
    <I18nContext.Provider value={i18n}>
      <main className="app">
        <Header
          metrics={metrics}
          profile={activeProfile}
          source={source}
          transportState={transportState}
          targetUrl={targetUrl}
          refreshIntervalMs={refreshIntervalMs}
          savedTargets={savedTargets}
          updatedAt={updatedAt}
          connectionActionPending={connectionActionPending}
          onApply={handleConnectionSettingsApply}
          onSelectSavedTarget={handleSavedTargetSelect}
          onDeleteTarget={handleDeleteSavedTarget}
          onUpdateTargetNote={handleSavedTargetNoteUpdate}
        />
        <DeviceFace history={history} metrics={metrics} profile={activeProfile} />
        {showAppearanceSwitcher ? (
          <ProfileSwitcher
            activeProfile={activeProfile}
            detectedProfile={detectedProfile}
            onChange={(profile) => setActiveProfileKey(profile.key)}
          />
        ) : null}
        <SummaryStrip heap={heap} metrics={metrics} profile={activeProfile} />
        <section className="ports-grid" aria-label={i18n.t("portTelemetry")}>
          {metrics.ports.map((port) => (
            <PortCard key={port.id} port={port} />
          ))}
        </section>
        <section className="dashboard-grid">
          <PowerChart history={history} />
          <RuntimePanel metrics={metrics} heap={heap} />
        </section>
        <LongHistoryPanel targetUrl={targetUrl} metrics={metrics} ports={metrics.ports} updatedAt={updatedAt} />
        <DiagnosticsDeck heap={heap} history={history} machineInfo={machineInfo} metrics={metrics} />
      </main>
    </I18nContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
