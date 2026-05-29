import React from "react";

import type { SavedTarget } from "./api";
import type { DashboardData, LiveTransportState } from "./hooks/useDashboardData";
import type { Language } from "./preferences";

export type TranslationKey = keyof typeof translations.zh;

export const translations = {
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
    collectingLiveSamples: "正在收集实时样本",
    collectingLiveSamplesHelp: "至少需要两个时间点后才显示趋势曲线，避免把单次快照误读为变化趋势。",
    refreshingLive: "正在刷新实时数据",
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
    collectingLiveSamples: "Collecting live samples",
    collectingLiveSamplesHelp: "Trends appear after at least two timestamps, so a single snapshot is not shown as a completed curve.",
    refreshingLive: "Refreshing live data",
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

export function translate(language: Language, key: TranslationKey) {
  return translations[language][key];
}

export function sourceLabel(language: Language, source: DashboardData["source"]) {
  if (source === "device") return translate(language, "sourceDevice");
  if (source === "offline") return translate(language, "sourceOffline");
  return translate(language, "sourceMock");
}

export function transportLabel(language: Language, state: LiveTransportState) {
  if (state === "sse") return translate(language, "transportSse");
  if (state === "reconnecting") return translate(language, "transportReconnecting");
  if (state === "fallback") return translate(language, "transportFallback");
  return translate(language, "transportConnecting");
}

export function targetStatusLabel(language: Language, status: SavedTarget["lastStatus"]) {
  if (status === "online") return translate(language, "statusOnline");
  if (status === "offline") return translate(language, "statusOffline");
  return translate(language, "statusUnknown");
}

export const I18nContext = React.createContext<{
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
}>({
  language: "zh",
  setLanguage: () => undefined,
  t: (key) => translations.zh[key],
});

export function useI18n() {
  return React.useContext(I18nContext);
}

export function LanguageToggle() {
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
