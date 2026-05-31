import React from "react";
import { createRoot } from "react-dom/client";
import {
  Cpu,
  Gauge,
  HardDrive,
  Pencil,
  Radio,
  RefreshCw,
  Settings,
  Zap,
} from "lucide-react";

import {
  getServerSession,
  fetchMqttControlState,
  fetchMqttStatus,
  login,
  normalizeDeviceTarget,
  saveMqttConfig,
  saveServerConfig,
  sendMqttControl,
  setActiveServerTarget,
  setMqttPortPower,
  setMqttTelemetryStream,
  type MqttControlAction,
  type MqttControlState,
  type MqttControlStateResult,
  deleteSavedTarget,
  updateSavedTargetNote,
  type MqttConfig,
  type MqttStatus,
  type MqttPowerFeatures,
  type MqttPortConfig,
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
  formatTemperature,
  formatDuration,
  formatResetReason,
  kilobytes,
  maxTemperature,
  milliwattHours,
  portLabel,
  portRuntimeState,
  type PortRuntimeState,
  protocolName,
  temperatureLevel,
  volts,
  watts,
} from "./format";
import { useDashboardData, type DashboardData, type DeviceStatus, type FrontendTransportState, type LiveTransportState } from "./hooks/useDashboardData";
import { DeviceFace } from "./components/device";
import { DiagnosticsDeck } from "./components/diagnostics";
import { LongHistoryPanel, PowerChart } from "./components/history";
import {
  I18nContext,
  LanguageToggle,
  frontendTransportLabel,
  sourceLabel,
  targetStatusLabel,
  transportLabel,
  translate,
  useI18n,
  type TranslationKey,
} from "./i18n";
import {
  clampRefreshInterval,
  readDeviceTarget,
  readLanguage,
  readRefreshInterval,
  writeDeviceTarget,
  writeLanguage,
  writeRefreshInterval,
  type Language,
} from "./preferences";
import type { HeapMetrics, MachineInfo, Metrics, PortMetrics, TaskMetrics } from "./types";
import { registerPwa } from "./pwa";
import { appVersion } from "./version";
import "./styles.css";

const NO_POWER_CONFIRM_SAMPLES = 2;
const CUSTOM_PDO_MIN_MV = 5000;
const CUSTOM_PDO_MAX_MV = 20000;
const STANDARD_PDO_VOLTAGES = new Set([5000, 9000, 15000, 20000]);
type EditablePowerFeatureKey = Exclude<keyof MqttPowerFeatures, "limitedCurrentMode">;
const POWER_FEATURE_KEYS: Array<keyof MqttPowerFeatures> = [
  "enableUfcs",
  "enableHvScp",
  "enableLvScp",
  "enableFcp",
  "enableQc3plus",
  "enableQc3p0",
  "enableQc2p0",
  "enableApple",
  "enableAfc",
  "enableSamsung",
  "enableSfcp",
  "enableTfcp",
  "enablePe",
  "enablePd",
  "enablePdCompatMode",
  "enablePdLvpps",
  "enablePdHvpps",
  "enablePdSprAvs",
  "enablePdEpr",
  "enablePdRpi",
  "enablePdHardResetOnRefusal",
  "limitedCurrentMode",
];
const EDITABLE_POWER_FEATURE_KEYS = POWER_FEATURE_KEYS.filter((key): key is EditablePowerFeatureKey => key !== "limitedCurrentMode");
const PD_POWER_FEATURE_KEYS = new Set<keyof MqttPowerFeatures>([
  "enablePd",
  "enablePdCompatMode",
  "enablePdLvpps",
  "enablePdHvpps",
  "enablePdSprAvs",
  "enablePdEpr",
  "enablePdRpi",
  "enablePdHardResetOnRefusal",
]);
const POWER_FEATURE_GROUPS: Array<{
  titleKey: TranslationKey;
  subtitleKey: TranslationKey;
  keys: EditablePowerFeatureKey[];
}> = [
  {
    titleKey: "protocolGroupBase",
    subtitleKey: "protocolGroupBaseHelp",
    keys: ["enableApple", "enableSamsung"],
  },
  {
    titleKey: "protocolGroupFastCharge",
    subtitleKey: "protocolGroupFastChargeHelp",
    keys: [
      "enableUfcs",
      "enableHvScp",
      "enableLvScp",
      "enableFcp",
      "enableQc3plus",
      "enableQc3p0",
      "enableQc2p0",
      "enableAfc",
      "enableSfcp",
      "enableTfcp",
      "enablePe",
    ],
  },
  {
    titleKey: "protocolGroupPd",
    subtitleKey: "protocolGroupPdHelp",
    keys: [
      "enablePd",
      "enablePdCompatMode",
      "enablePdLvpps",
      "enablePdHvpps",
      "enablePdSprAvs",
      "enablePdEpr",
      "enablePdRpi",
      "enablePdHardResetOnRefusal",
    ],
  },
];

const POWER_FEATURE_TEXT: Record<keyof MqttPowerFeatures, { title: string; subtitle: string }> = {
  enableUfcs: { title: "UFCS 2.0", subtitle: "融合快充标准，最高功率取决于端口能力" },
  enableHvScp: { title: "HVSCP", subtitle: "Huawei SCP high voltage, 10V" },
  enableLvScp: { title: "LVSCP", subtitle: "Huawei SCP low voltage, 5V" },
  enableFcp: { title: "FCP", subtitle: "Huawei Fast Charge Protocol" },
  enableQc3plus: { title: "QC3.0+", subtitle: "Qualcomm Quick Charge 3.0+" },
  enableQc3p0: { title: "QC3.0", subtitle: "Qualcomm Quick Charge 3.0" },
  enableQc2p0: { title: "QC2.0", subtitle: "Qualcomm Quick Charge 2.0" },
  enableApple: { title: "Apple 2.4A", subtitle: "Apple 5V D+/D- charging profile" },
  enableAfc: { title: "AFC", subtitle: "Samsung Adaptive Fast Charging" },
  enableSamsung: { title: "Samsung 5V", subtitle: "Samsung 5V 2.1A profile" },
  enableSfcp: { title: "SFCP", subtitle: "Spreadtrum Fast Charge Protocol" },
  enableTfcp: { title: "TFCP", subtitle: "Transsion Fast Charge Protocol" },
  enablePe: { title: "PE", subtitle: "MediaTek Pump Express" },
  enablePd: { title: "USB PD", subtitle: "USB Power Delivery" },
  enablePdCompatMode: { title: "PD Compat", subtitle: "USB PD compatibility mode" },
  enablePdLvpps: { title: "PD LV PPS", subtitle: "Low-voltage PPS capability" },
  enablePdHvpps: { title: "PD HV PPS", subtitle: "High-voltage PPS capability" },
  enablePdSprAvs: { title: "PD SPR AVS", subtitle: "Adjustable voltage supply in SPR range" },
  enablePdEpr: { title: "PD EPR", subtitle: "Extended Power Range" },
  enablePdRpi: { title: "PD 5V5A", subtitle: "5V high-current compatibility" },
  enablePdHardResetOnRefusal: { title: "PD Hard Reset", subtitle: "Hard reset on PD request refusal" },
  limitedCurrentMode: { title: "Limited Current", subtitle: "Limit current for compatibility" },
};

function defaultPowerFeatures(): MqttPowerFeatures {
  return Object.fromEntries(POWER_FEATURE_KEYS.map((key) => [key, true])) as MqttPowerFeatures;
}

function defaultPortConfigs(length = 8): MqttPortConfig[] {
  return Array.from({ length }, () => ({ version: 2, features: defaultPowerFeatures() }));
}

function protocolKeysForPort(port?: PortMetrics) {
  return EDITABLE_POWER_FEATURE_KEYS.filter((key) => port?.port_type === "C" || !PD_POWER_FEATURE_KEYS.has(key));
}

function mergeProtocolFeaturesForTarget(
  source: MqttPowerFeatures,
  target: MqttPowerFeatures,
  targetPort?: PortMetrics,
) {
  const next = { ...target };
  for (const key of protocolKeysForPort(targetPort)) {
    next[key] = source[key];
  }
  return next;
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

function useStablePortRuntimeStates(ports: PortMetrics[]) {
  const stateRef = React.useRef(new Map<number, {
    raw: PortRuntimeState;
    stable: PortRuntimeState;
    noPowerSamples: number;
  }>());

  return React.useMemo(() => {
    const nextRef = new Map<number, {
      raw: PortRuntimeState;
      stable: PortRuntimeState;
      noPowerSamples: number;
    }>();
    const stableStates = new Map<number, PortRuntimeState>();

    ports.forEach((port) => {
      const raw = portRuntimeState(port);
      const previous = stateRef.current.get(port.id);
      const noPowerSamples = raw === "no-power"
        ? previous?.raw === "no-power"
          ? previous.noPowerSamples + 1
          : 1
        : 0;
      const stable = raw === "no-power" &&
        previous?.stable === "attached" &&
        noPowerSamples < NO_POWER_CONFIRM_SAMPLES
        ? "attached"
        : raw;

      nextRef.set(port.id, { raw, stable, noPowerSamples });
      stableStates.set(port.id, stable);
    });

    stateRef.current = nextRef;
    return stableStates;
  }, [ports]);
}

function AppFooter() {
  return <footer className="app-footer">IonBridgeWeb · Web {appVersion}</footer>;
}

function Header({
  metrics,
  profile,
  deviceStatus,
  frontendTransportState,
  source,
  transportState,
  updatedAt,
  targetUrl,
  refreshIntervalMs,
  savedTargets,
  mqttConfig,
  mqttStatus,
  activeDeviceKey,
  onApply,
  onMqttApply,
  onMqttStream,
  onMqttControl,
  onMqttQueryState,
  onSelectSavedTarget,
  onDeleteTarget,
  onUpdateTargetNote,
  connectionActionPending,
}: {
  metrics: Metrics;
  profile: DeviceVisualProfile;
  deviceStatus: DeviceStatus;
  frontendTransportState: FrontendTransportState;
  source: DashboardData["source"];
  transportState: LiveTransportState;
  updatedAt: Date | null;
  targetUrl: string;
  refreshIntervalMs: number;
  savedTargets: SavedTarget[];
  mqttConfig?: MqttConfig;
  mqttStatus?: MqttStatus;
  activeDeviceKey?: string | null;
  onApply: (targetUrl: string, refreshIntervalMs: number, note: string) => void | Promise<void>;
  onMqttApply: (config: { enabled: boolean; brokerUrl: string; username: string; password?: string }) => void | Promise<void>;
  onMqttStream: (enabled: boolean) => void | Promise<void>;
  onMqttControl: (action: MqttControlAction, params?: Record<string, unknown>) => void | Promise<void>;
  onMqttQueryState: (ports: number[]) => Promise<MqttControlStateResult>;
  onSelectSavedTarget: (target: SavedTarget) => void | Promise<void>;
  onDeleteTarget: (targetUrl: string) => void | Promise<void>;
  onUpdateTargetNote: (target: SavedTarget, note: string) => void | Promise<void>;
  connectionActionPending?: boolean;
}) {
  const { language, t } = useI18n();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const totalPower = metrics.ports.reduce((sum, port) => sum + watts(port), 0);
  const hottest = maxTemperature(metrics.ports.map((port) => port.die_temperature));
  const productTitle = profile.family === "CP02"
    ? t("cp02Title")
    : t("mirrorTitle");
  const productEyebrow = profile.family === "CP02"
    ? `CP-02 ${profile.variant.toUpperCase()}`
    : `${profile.family} Mirror ${profile.variant.toUpperCase()}`;
  const activeNote = savedTargets.find((target) => target.targetUrl === normalizeDeviceTarget(targetUrl))?.note ?? "";
  const dataText = React.useMemo(() => {
    const base = transportLabel(language, transportState);
    const isHttpMode = transportState === "http" || transportState === "fallback" || transportState === "connecting" || transportState === "reconnecting";
    if (!isHttpMode) return base;
    if (!mqttConfig?.enabled) return `${base} · ${t("mqttNotConfigured")}`;
    if (mqttStatus?.connected && !mqttStatus.lastMessageAt) return `${base} · ${t("mqttWaitingTelemetry")}`;
    if (mqttStatus?.connected && mqttStatus.lastMessageAt) return `${base} · ${t("mqttNoPortTelemetry")}`;
    return base;
  }, [language, mqttConfig?.enabled, mqttStatus?.connected, mqttStatus?.lastMessageAt, t, transportState]);
  const frontendText = frontendTransportLabel(language, frontendTransportState);

  return (
    <>
      <header className="app-header">
        <div className="product-identity">
          <p className="eyebrow">{productEyebrow}</p>
          <h1>{productTitle}</h1>
          <p className="subhead">
            {profile.displayKind === "amber" ? t("amberSubhead") : t("ledSubhead")}
          </p>
        </div>
        <div className="header-stack">
          <div className="header-status" aria-label={t("realtimeSummary")}>
            <div className={`live-chip ${source}`}>
              <span />
              {targetStatusLabel(language, deviceStatus)} · {sourceLabel(language, source)}
              <small className="live-chip-meta">
                <b>{t("frontendPrefix")}</b>{frontendText}
                <i aria-hidden="true" />
                <b>{t("dataPrefix")}</b>{dataText}
              </small>
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
          <div className="header-metrics">
            <div className="metric-pill">
              <Zap size={17} />
              <span>{totalPower.toFixed(1)}W</span>
            </div>
            <div className={`metric-pill temp-${temperatureLevel(hottest)}`}>
              <Gauge size={17} />
              <span>{formatTemperature(hottest)}</span>
            </div>
            <div className="metric-pill">
              <Radio size={17} />
              <span>{metrics.wifi.rssi}dBm</span>
            </div>
          </div>
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
          <MqttControl
            activeDeviceKey={activeDeviceKey}
            config={mqttConfig}
            profile={profile}
            status={mqttStatus}
            disabled={connectionActionPending}
            ports={metrics.ports}
            onApply={onMqttApply}
            onControl={onMqttControl}
            onQueryState={onMqttQueryState}
            onStream={onMqttStream}
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

function MqttControl({
  activeDeviceKey,
  config,
  profile,
  status,
  ports,
  disabled = false,
  onApply,
  onControl,
  onQueryState,
  onStream,
}: {
  activeDeviceKey?: string | null;
  config?: MqttConfig;
  profile: DeviceVisualProfile;
  status?: MqttStatus;
  ports: PortMetrics[];
  disabled?: boolean;
  onApply: (config: { enabled: boolean; brokerUrl: string; username: string; password?: string }) => void | Promise<void>;
  onControl: (action: MqttControlAction, params?: Record<string, unknown>) => void | Promise<void>;
  onQueryState: (ports: number[]) => Promise<MqttControlStateResult>;
  onStream: (enabled: boolean) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [enabled, setEnabled] = React.useState(Boolean(config?.enabled));
  const [brokerUrl, setBrokerUrl] = React.useState(config?.brokerUrl ?? "");
  const [username, setUsername] = React.useState(config?.username ?? "");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [commandBusy, setCommandBusy] = React.useState("");
  const [syncingState, setSyncingState] = React.useState(false);
  const [lastSyncedAt, setLastSyncedAt] = React.useState<number | null>(null);
  const [syncErrors, setSyncErrors] = React.useState(0);
  const [syncedControlState, setSyncedControlState] = React.useState<MqttControlState>({});
  const [error, setError] = React.useState("");
  const [isEditingConfig, setIsEditingConfig] = React.useState(false);
  const [controlOpen, setControlOpen] = React.useState(false);
  const [strategy, setStrategy] = React.useState("6");
  const [temperatureMode, setTemperatureMode] = React.useState("0");
  const [allocation, setAllocation] = React.useState<string[]>(["0", "0", "0", "0", "0"]);
  const [protocolPort, setProtocolPort] = React.useState("0");
  const [portConfigs, setPortConfigs] = React.useState<MqttPortConfig[]>(defaultPortConfigs());
  const [pdoPort, setPdoPort] = React.useState("1");
  const [pdoVoltage, setPdoVoltage] = React.useState("11000");
  const [cablePort, setCablePort] = React.useState("1");
  const [cableDisabled, setCableDisabled] = React.useState(false);
  const [cableResistance, setCableResistance] = React.useState("0");
  const [cableOffset, setCableOffset] = React.useState("0");
  const [displayIntensity, setDisplayIntensity] = React.useState("60");
  const [displayMode, setDisplayMode] = React.useState("2");
  const [displayRotation, setDisplayRotation] = React.useState("0");
  const [idleAnimation, setIdleAnimation] = React.useState("0");
  const canControl = Boolean(activeDeviceKey && config?.enabled && status?.connected);
  const controlBusy = commandBusy !== "" || syncingState;
  const controlDisabled = disabled || controlBusy || !canControl;
  const visiblePorts = ports.slice().sort((a, b) => a.id - b.id);
  const supportsDisplayAnimation = profile.displayKind === "amber";
  const supportsManualDisplay = profile.displayKind === "amber";
  const selectedProtocolPortId = Number(protocolPort);
  const selectedProtocolPort = visiblePorts.find((port) => port.id === selectedProtocolPortId);
  const visibleProtocolKeys = protocolKeysForPort(selectedProtocolPort);
  const sideC4Port = visiblePorts.find((port) => port.id === 4);
  const c4ApplianceMode = sideC4Port?.port_type === "A";
  const pdoVoltageNumber = Number(pdoVoltage);
  const pdoVoltageInvalid = !Number.isInteger(pdoVoltageNumber) ||
    pdoVoltageNumber < CUSTOM_PDO_MIN_MV ||
    pdoVoltageNumber > CUSTOM_PDO_MAX_MV ||
    STANDARD_PDO_VOLTAGES.has(pdoVoltageNumber);

  React.useEffect(() => {
    if (isEditingConfig || busy) return;
    setEnabled(Boolean(config?.enabled));
    setBrokerUrl(config?.brokerUrl ?? "");
    setUsername(config?.username ?? "");
    setPassword("");
  }, [config?.enabled, config?.brokerUrl, config?.username, isEditingConfig, busy]);

  React.useEffect(() => {
    setLastSyncedAt(null);
    setSyncErrors(0);
    setSyncedControlState({});
  }, [activeDeviceKey]);

  React.useEffect(() => {
    if (!supportsManualDisplay && displayMode === "1") {
      setDisplayMode("2");
    }
  }, [displayMode, supportsManualDisplay]);

  React.useEffect(() => {
    setAllocation((current) => {
      const next = visiblePorts.map((port, index) => current[index] ?? String(port.power_budget || 0));
      return next.length > 0 ? next : ["0", "0", "0", "0", "0"];
    });
  }, [visiblePorts.length]);

  React.useEffect(() => {
    if (!controlOpen || !canControl || syncingState) return;
    void syncControlState();
  }, [controlOpen, canControl, activeDeviceKey, visiblePorts.length]);

  React.useEffect(() => {
    applyCableState(syncedControlState, cablePort);
  }, [cablePort, syncedControlState]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      await onApply({
        enabled,
        brokerUrl,
        username,
        ...(password ? { password } : {}),
      });
      setIsEditingConfig(false);
    } catch {
      setError(t("mqttCommandFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function resetMqttConfig() {
    if (busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      await onApply({
        enabled: false,
        brokerUrl: "",
        username: "",
        password: "",
      });
      setEnabled(false);
      setBrokerUrl("");
      setUsername("");
      setPassword("");
      setIsEditingConfig(false);
    } catch {
      setError(t("mqttCommandFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function runCommand(label: string, action: MqttControlAction, params: Record<string, unknown> = {}) {
    if (controlDisabled) return;
    setCommandBusy(label);
    setError("");
    try {
      await onControl(action, params);
    } catch {
      setError(t("mqttCommandFailed"));
    } finally {
      setCommandBusy("");
    }
  }

  async function syncControlState() {
    if (!canControl || syncingState) return;
    setSyncingState(true);
    setError("");
    try {
      const result = await onQueryState(visiblePorts.map((port) => port.id));
      applyControlState(result.state);
      setSyncErrors(Object.keys(result.errors ?? {}).length);
      setLastSyncedAt(Date.now());
    } catch {
      setSyncErrors((count) => count + 1);
      setError(t("mqttStateSyncFailed"));
    } finally {
      setSyncingState(false);
    }
  }

  function applyControlState(state: MqttControlState) {
    setSyncedControlState(state);
    if (Number.isFinite(state.chargingStrategy)) setStrategy(String(state.chargingStrategy));
    if (state.portConfigs?.length) setPortConfigs(defaultPortConfigs().map((config, index) => state.portConfigs?.[index] ?? config));
    if (Number.isFinite(state.displayIntensity)) setDisplayIntensity(String(state.displayIntensity));
    if (Number.isFinite(state.displayMode)) {
      const mode = String(state.displayMode);
      setDisplayMode(!supportsManualDisplay && mode === "1" ? "2" : mode);
    }
    if (Number.isFinite(state.displayRotation)) setDisplayRotation(String(state.displayRotation));
    if (Number.isFinite(state.idleAnimation)) setIdleAnimation(String(state.idleAnimation));
    applyCableState(state, cablePort);
  }

  function applyCableState(state: MqttControlState, port: string) {
    const cable = state.cableCompensation?.[port];
    if (cable) {
      setCableDisabled(!cable.enable);
      setCableResistance(String(cable.resistance));
      setCableOffset(String(cable.voltageOffset));
    }
  }

  function updatePortFeature(portId: number, key: keyof MqttPowerFeatures, enabled: boolean) {
    setPortConfigs((current) => defaultPortConfigs().map((config, index) => {
      const existing = current[index] ?? config;
      if (index !== portId) return existing;
      return {
        ...existing,
        features: { ...existing.features, [key]: enabled },
      };
    }));
  }

  function applyProtocolConfig(mode: "one" | "all") {
    const portId = selectedProtocolPortId;
    const nextConfigs = defaultPortConfigs().map((config, index) => portConfigs[index] ?? config);
    const portMask = mode === "all"
      ? visiblePorts.reduce((mask, port) => mask | (1 << port.id), 0)
      : 1 << portId;
    if (mode === "all") {
      const source = nextConfigs[portId];
      for (const port of visiblePorts) {
        const target = nextConfigs[port.id];
        nextConfigs[port.id] = {
          ...target,
          features: mergeProtocolFeaturesForTarget(source.features, target.features, port),
        };
      }
      setPortConfigs(nextConfigs);
    }
    void runCommand(mode === "all" ? "port-config-all" : "port-config", "portConfig", {
      portMask,
      configs: nextConfigs,
    });
  }

  async function runStream(enabled: boolean) {
    if (disabled || commandBusy || !activeDeviceKey || !config?.enabled || !status?.connected) return;
    setCommandBusy("stream");
    setError("");
    try {
      await onStream(enabled);
    } catch {
      setError(t("mqttCommandFailed"));
    } finally {
      setCommandBusy("");
    }
  }

  return (
    <div className="mqtt-control">
      <form className="mqtt-config-form" onSubmit={submit}>
        <div className="mqtt-control-head">
          <div>
            <p className="eyebrow">{t("mqttSettings")}</p>
            <strong>{status?.connected ? t("mqttConnected") : t("mqttDisconnected")}</strong>
            {status?.lastMessageAt ? <small>{t("mqttLastMessage")} {new Date(status.lastMessageAt).toLocaleTimeString("zh-CN", { hour12: false })}</small> : null}
            {status?.lastError ? <small>{status.lastError}</small> : null}
          </div>
          <label className="mqtt-toggle">
            <input checked={enabled} disabled={busy || disabled} onChange={(event) => {
              setIsEditingConfig(true);
              setEnabled(event.target.checked);
            }} type="checkbox" />
            <span>{t("mqttEnable")}</span>
          </label>
        </div>
        <input
          aria-label={t("mqttBroker")}
          disabled={busy || disabled}
          onChange={(event) => {
            setIsEditingConfig(true);
            setBrokerUrl(event.target.value);
          }}
          placeholder="mqtt://127.0.0.1:1883"
          value={brokerUrl}
        />
        <input
          aria-label={t("mqttUsername")}
          disabled={busy || disabled}
          onChange={(event) => {
            setIsEditingConfig(true);
            setUsername(event.target.value);
          }}
          placeholder={t("mqttUsername")}
          value={username}
        />
        <input
          aria-label={t("mqttPassword")}
          disabled={busy || disabled}
          onChange={(event) => {
            setIsEditingConfig(true);
            setPassword(event.target.value);
          }}
          placeholder={config?.hasPassword ? t("mqttPasswordPlaceholder") : t("mqttPassword")}
          type="password"
          value={password}
        />
        <div className="mqtt-actions">
          <button disabled={busy || disabled} type="submit">{busy ? t("validatingDevice") : t("mqttSave")}</button>
          <button disabled={busy || disabled} onClick={resetMqttConfig} type="button">{t("mqttResetDefault")}</button>
          <button disabled={disabled || commandBusy !== "" || !activeDeviceKey || !config?.enabled || !status?.connected} onClick={() => runStream(true)} type="button">
            {t("mqttStartStream")}
          </button>
          <button disabled={disabled || commandBusy !== "" || !activeDeviceKey || !config?.enabled || !status?.connected} onClick={() => runStream(false)} type="button">
            {t("mqttStopStream")}
          </button>
        </div>
      </form>

      <details className="mqtt-control-console" open={controlOpen} onToggle={(event) => setControlOpen(event.currentTarget.open)}>
        <summary>
          <span>{t("mqttControl")}</span>
          <small>
            {syncingState
              ? t("mqttStateSyncing")
              : lastSyncedAt
                ? `${t("mqttStateSynced")} ${new Date(lastSyncedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
                : t("mqttControlHint")}
          </small>
        </summary>
        <div className="mqtt-sync-bar">
          <span>{syncErrors > 0 ? t("mqttStatePartial") : t("mqttStateReadable")}</span>
          <button disabled={controlDisabled} onClick={() => void syncControlState()} type="button">
            {syncingState ? t("mqttStateSyncing") : t("mqttStateSync")}
          </button>
        </div>
        <div className="mqtt-control-groups">
          <section>
            <h3>{t("deviceSettings")}</h3>
            <div className="control-button-row">
              <button disabled={controlDisabled} onClick={() => runCommand("device-on", "devicePower", { enabled: true })} type="button">{t("devicePowerOn")}</button>
              <button disabled={controlDisabled} onClick={() => runCommand("device-off", "devicePower", { enabled: false })} type="button">{t("devicePowerOff")}</button>
              <button disabled={controlDisabled} onClick={() => window.confirm(t("rebootDevice")) && runCommand("reboot", "rebootDevice")} type="button">{t("rebootDevice")}</button>
            </div>
          </section>

          <section>
            <h3>{t("chargingPolicy")}</h3>
            <div className="control-row">
              <select value={strategy} onChange={(event) => setStrategy(event.target.value)}>
                <option value="6">{t("strategyCompatible")}</option>
                <option value="1">{t("strategySlow")}</option>
                <option value="7">{t("strategyPerformance")}</option>
                <option value="8">{t("strategyUltraSingle")}</option>
              </select>
              <button disabled={controlDisabled} onClick={() => runCommand("strategy", "chargingStrategy", { strategy: Number(strategy) })} type="button">{t("sendCommand")}</button>
            </div>
            <div className="control-row">
              <select value={temperatureMode} onChange={(event) => setTemperatureMode(event.target.value)}>
                <option value="0">{t("temperaturePower")}</option>
                <option value="1">{t("temperatureThermal")}</option>
              </select>
              <button disabled={controlDisabled} onClick={() => runCommand("temperature", "temperatureMode", { mode: Number(temperatureMode) })} type="button">{t("sendCommand")}</button>
            </div>
          </section>

          <section>
            <h3>{t("temporaryPower")}</h3>
            <div className="allocation-grid">
              {visiblePorts.map((port, index) => (
                <label key={port.id}>
                  <span>{portLabel(port)}</span>
                  <input
                    min="0"
                    max="240"
                    onChange={(event) => setAllocation((current) => current.map((value, valueIndex) => valueIndex === index ? event.target.value : value))}
                    type="number"
                    value={allocation[index] ?? "0"}
                  />
                </label>
              ))}
            </div>
            <button disabled={controlDisabled} onClick={() => runCommand("allocation", "temporaryAllocation", { powerAllocation: allocation.map(Number) })} type="button">{t("applyAllocation")}</button>
          </section>

          <section className="protocol-section">
            <h3>{t("protocolCompatibility")}</h3>
            <div className="control-row">
              <select value={protocolPort} onChange={(event) => setProtocolPort(event.target.value)}>
                {visiblePorts.map((port) => <option key={port.id} value={port.id}>{portLabel(port)}</option>)}
              </select>
              <button disabled={controlDisabled} onClick={() => applyProtocolConfig("one")} type="button">{t("applyCurrentPort")}</button>
              <button disabled={controlDisabled} onClick={() => applyProtocolConfig("all")} type="button">{t("applyAllPorts")}</button>
            </div>
            <div className="protocol-groups">
              <section className="protocol-group">
                <div className="protocol-group-heading">
                  <div>
                    <h4>{t("protocolGroupBase")}</h4>
                    <p>{t("protocolGroupBaseHelp")}</p>
                  </div>
                </div>
                <div className="protocol-list">
                  <article className="protocol-card fixed">
                    <div>
                      <strong>BC 1.2</strong>
                      <small>{t("bc12Help")}</small>
                    </div>
                    <span>{t("alwaysOn")}</span>
                  </article>
                  {POWER_FEATURE_GROUPS[0].keys.filter((key) => visibleProtocolKeys.includes(key)).map((key) => {
                    const meta = POWER_FEATURE_TEXT[key];
                    const checked = portConfigs[selectedProtocolPortId]?.features[key] ?? false;
                    return (
                      <label className="protocol-card" key={key}>
                        <div>
                          <strong>{meta.title}</strong>
                          <small>{meta.subtitle}</small>
                        </div>
                        <input
                          checked={checked}
                          onChange={(event) => updatePortFeature(selectedProtocolPortId, key, event.target.checked)}
                          type="checkbox"
                        />
                      </label>
                    );
                  })}
                </div>
              </section>
              {POWER_FEATURE_GROUPS.slice(1).map((group) => {
                const groupKeys = group.keys.filter((key) => visibleProtocolKeys.includes(key));
                if (!groupKeys.length) return null;
                return (
                  <section className="protocol-group" key={group.titleKey}>
                    <div className="protocol-group-heading">
                      <div>
                        <h4>{t(group.titleKey)}</h4>
                        <p>{t(group.subtitleKey)}</p>
                      </div>
                    </div>
                    <div className="protocol-list">
                      {groupKeys.map((key) => {
                        const meta = POWER_FEATURE_TEXT[key];
                        const checked = portConfigs[selectedProtocolPortId]?.features[key] ?? false;
                        return (
                          <label className="protocol-card" key={key}>
                            <div>
                              <strong>{meta.title}</strong>
                              <small>{meta.subtitle}</small>
                            </div>
                            <input
                              checked={checked}
                              onChange={(event) => updatePortFeature(selectedProtocolPortId, key, event.target.checked)}
                              type="checkbox"
                            />
                          </label>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
              <section className="protocol-group protocol-group-readonly">
                <div className="protocol-group-heading">
                  <div>
                    <h4>{t("protocolGroupProtection")}</h4>
                    <p>{t("protocolGroupProtectionHelp")}</p>
                  </div>
                </div>
                <article className="protocol-card fixed">
                  <div>
                    <strong>{POWER_FEATURE_TEXT.limitedCurrentMode.title}</strong>
                    <small>{POWER_FEATURE_TEXT.limitedCurrentMode.subtitle}</small>
                  </div>
                  <span>{portConfigs[selectedProtocolPortId]?.features.limitedCurrentMode ? t("enabled") : t("disabled")}</span>
                </article>
              </section>
            </div>
          </section>

          <section>
            <h3>{t("c4ApplianceMode")}</h3>
            <div className="control-status-card">
              <div>
                <strong>{c4ApplianceMode ? t("c4ApplianceModeOn") : t("c4ApplianceModeOff")}</strong>
                <small>{t("c4ApplianceModeHelp")}</small>
              </div>
              <span>{sideC4Port ? sideC4Port.port_type : "N/A"}</span>
            </div>
            <div className="control-button-row">
              <button
                disabled={controlDisabled || !sideC4Port || c4ApplianceMode}
                onClick={() => runCommand("c4-appliance", "portType", { port: 4, portType: 0 })}
                type="button"
              >
                {t("enableC4Appliance")}
              </button>
              <button
                disabled={controlDisabled || !sideC4Port || !c4ApplianceMode}
                onClick={() => runCommand("c4-typec", "portType", { port: 4, portType: 1 })}
                type="button"
              >
                {t("restoreC4TypeC")}
              </button>
            </div>
          </section>

          <section>
            <h3>{t("customPdo")}</h3>
            <div className="control-row">
              <select value={pdoPort} onChange={(event) => setPdoPort(event.target.value)}>
                {visiblePorts.filter((port) => port.port_type === "C").map((port) => <option key={port.id} value={port.id}>{portLabel(port)}</option>)}
              </select>
              <input
                aria-label={t("customPdoVoltage")}
                max={CUSTOM_PDO_MAX_MV}
                min={CUSTOM_PDO_MIN_MV}
                onChange={(event) => setPdoVoltage(event.target.value)}
                placeholder="11000"
                step="100"
                type="number"
                value={pdoVoltage}
              />
              <span className="control-value">mV</span>
              <button disabled={controlDisabled || pdoVoltageInvalid} onClick={() => runCommand("pdo", "customPdoVoltage", { port: Number(pdoPort), voltageMv: Number(pdoVoltage) })} type="button">{t("sendCommand")}</button>
            </div>
            <small className={`control-note ${pdoVoltageInvalid ? "warning" : ""}`}>{t("customPdoHelp")}</small>
          </section>

          <section>
            <h3>{t("cableCompensation")}</h3>
            <div className="control-row">
              <select value={cablePort} onChange={(event) => setCablePort(event.target.value)}>
                {visiblePorts.map((port) => <option key={port.id} value={port.id}>{portLabel(port)}</option>)}
              </select>
              <select value={cableResistance} onChange={(event) => setCableResistance(event.target.value)}>
                <option value="0">65mOhm</option>
                <option value="1">100mOhm</option>
              </select>
              <select value={cableOffset} onChange={(event) => setCableOffset(event.target.value)}>
                <option value="0">0mV</option>
                <option value="1">100mV</option>
                <option value="2">150mV</option>
                <option value="3">200mV</option>
              </select>
              <label className="inline-check"><input checked={cableDisabled} onChange={(event) => setCableDisabled(event.target.checked)} type="checkbox" /> Disable</label>
              <button disabled={controlDisabled} onClick={() => runCommand("cable", "cableCompensation", { portMask: 1 << Number(cablePort), disable: cableDisabled, resistance: Number(cableResistance), voltageOffset: Number(cableOffset) })} type="button">{t("sendCommand")}</button>
            </div>
          </section>

          <section>
            <h3>{t("displayControl")}</h3>
            <div className="control-row">
              <input min="0" max="100" onChange={(event) => setDisplayIntensity(event.target.value)} type="range" value={displayIntensity} />
              <span className="control-value">{displayIntensity}%</span>
              <select value={displayMode} onChange={(event) => setDisplayMode(event.target.value)}>
                <option value="0">{t("displayOff")}</option>
                {supportsManualDisplay ? <option value="1">{t("displayManual")}</option> : null}
                <option value="2">{t("displayPowerMeter")}</option>
              </select>
              <button disabled={controlDisabled} onClick={() => runCommand("display-intensity", "displayIntensity", { intensity: Number(displayIntensity) })} type="button">{t("applyBrightness")}</button>
              <button disabled={controlDisabled} onClick={() => runCommand("display-mode", "displayMode", { mode: Number(displayMode) })} type="button">{t("applyDisplayMode")}</button>
            </div>
            {supportsDisplayAnimation ? (
              <div className="control-row">
                <select value={displayRotation} onChange={(event) => setDisplayRotation(event.target.value)}>
                  <option value="0">0deg</option>
                  <option value="1">90deg</option>
                  <option value="2">180deg</option>
                  <option value="3">270deg</option>
                </select>
                <select value={idleAnimation} onChange={(event) => setIdleAnimation(event.target.value)}>
                  <option value="0">{t("idleNone")}</option>
                  <option value="1">{t("idleMeteor")}</option>
                  <option value="2">{t("idleLife")}</option>
                </select>
                <button disabled={controlDisabled} onClick={() => runCommand("display-setup", "displaySetup", { intensity: Number(displayIntensity), rotation: Number(displayRotation), idleAnimation: Number(idleAnimation) })} type="button">{t("applyDisplay")}</button>
              </div>
            ) : (
              <small className="control-note">{t("displayAnimationUnsupported")}</small>
            )}
          </section>
        </div>
      </details>
      {error ? <strong className="target-error">{error}</strong> : null}
    </div>
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
      <AppFooter />
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
      <AppFooter />
    </main>
  );
}

function PortCard({
  port,
  runtimeState = portRuntimeState(port),
  isPeak = false,
  mqttEnabled = false,
  onSetPower,
}: {
  port: PortMetrics;
  runtimeState?: PortRuntimeState;
  isPeak?: boolean;
  mqttEnabled?: boolean;
  onSetPower?: (enabled: boolean) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = React.useState(false);
  const stateLabel = {
    attached: t("attached"),
    fault: t("portFault"),
    "no-power": t("noPower"),
    off: t("portOff"),
    protecting: t("portProtecting"),
    ready: t("ready"),
    recovering: t("portRecovering"),
    switching: t("portSwitching"),
  }[runtimeState];
  async function togglePower() {
    if (!onSetPower || busy) return;
    setBusy(true);
    try {
      await onSetPower(runtimeState === "off");
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={`port-card ${temperatureLevel(port.die_temperature)} port-${runtimeState} ${isPeak ? "peak-port" : ""} ${port.id === 4 ? "side-card" : ""}`}>
      <div className="port-card-top">
        <div>
          <p>{port.id === 4 ? `USB-C · ${t("sideSuffix")}` : port.port_type === "A" ? "USB-A" : "USB-C"}</p>
          <h2>{portLabel(port)}</h2>
        </div>
        <span className="state-dot">{stateLabel}</span>
      </div>
      <div className="power-number">{watts(port).toFixed(1)}W</div>
      <div className="port-grid">
        <span>{volts(port.voltage).toFixed(2)}V</span>
        <span>{amps(port.current).toFixed(2)}A</span>
        <span>{formatTemperature(port.die_temperature)}</span>
        <span>{protocolName(port.fc_protocol)}</span>
      </div>
      <div className="budget-row">
        <span>{t("portLimit")} {port.power_budget}W</span>
        <span>{t("portSessionShort")} {formatDuration(port.charging_duration_seconds)}</span>
      </div>
      {mqttEnabled ? (
        <button className="port-mqtt-action" disabled={busy} onClick={togglePower} type="button">
          {runtimeState === "off" ? t("portTurnOn") : t("portTurnOff")}
        </button>
      ) : null}
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
  const hottest = maxTemperature(metrics.ports.map((port) => port.die_temperature));

  return (
    <section className="summary-strip">
      <SummaryItem icon={<Zap size={18} />} label={t("totalPower")} value={`${totalPower.toFixed(1)}W`} detail={`${profile.totalPowerBudgetW}W ${t("modelMax")}`} />
      <SummaryItem icon={<Gauge size={18} />} label={t("thermalPeak")} value={formatTemperature(hottest)} detail={t("thermalDetail")} />
      <SummaryItem icon={<HardDrive size={18} />} label={t("heapUsed")} value={`${Math.round(heapUsed * 100)}%`} detail={`${Math.round(heap.total_free / 1024)}KB ${t("available")}`} />
      <SummaryItem icon={<Cpu size={18} />} label={t("runtime")} value={formatDuration(metrics.system.boot_time_seconds)} detail={metrics.system.app_version} />
    </section>
  );
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

function PortStateGuide() {
  const { t } = useI18n();
  const states: Array<{ className: string; label: TranslationKey; hint: TranslationKey }> = [
    { className: "port-attached", label: "attached", hint: "portAttachedHint" },
    { className: "port-no-power", label: "noPower", hint: "portNoPowerHint" },
    { className: "port-ready", label: "ready", hint: "portReadyHint" },
    { className: "port-off", label: "portOff", hint: "portOffHint" },
    { className: "port-switching", label: "portSwitching", hint: "portSwitchingHint" },
    { className: "port-protecting", label: "portProtecting", hint: "portProtectingHint" },
    { className: "port-recovering", label: "portRecovering", hint: "portRecoveringHint" },
    { className: "port-fault", label: "portFault", hint: "portFaultHint" },
  ];

  return (
    <section className="port-state-guide" aria-label={t("portStateLegend")}>
      <p>{t("portStateLegend")}</p>
      <div>
        {states.map((state) => (
          <span key={state.className} className={state.className} title={t(state.hint)}>
            <i className="state-dot">{t(state.label)}</i>
          </span>
        ))}
      </div>
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
  const { language, t } = useI18n();
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
          <dt>Reset</dt>
          <dd className="reset-reason">{formatResetReason(metrics.system.reset_reason, language)}</dd>
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
  const [mqttConfig, setMqttConfig] = React.useState<MqttConfig | undefined>();
  const [mqttStatus, setMqttStatus] = React.useState<MqttStatus | undefined>();
  const [savedTargets, setSavedTargets] = React.useState<SavedTarget[]>([]);
  const { ready, passwordRequired, serverSession, setPasswordRequired, setServerSession } = useServerSettings();
  const [activeProfileKey, setActiveProfileKey] = React.useState<string | null>(null);
  const [connectionActionPending, setConnectionActionPending] = React.useState(false);
  const connectionActionPendingRef = React.useRef(false);
  const handleLiveConfigUpdate = React.useCallback((nextConfig: ServerSession["config"]) => {
    setSavedTargets(nextConfig.targets);
    setMqttConfig(nextConfig.mqtt);
    setShowAppearanceSwitcher(Boolean(nextConfig.showAppearanceSwitcher));
  }, []);
  const handleAuthRequired = React.useCallback(() => {
    setPasswordRequired(true);
    setServerSession((current) => current ? { ...current, authenticated: false } : current);
  }, [setPasswordRequired, setServerSession]);
  const liveEnabled = ready && !passwordRequired;
  const activeSavedTarget = savedTargets.find((target) => target.targetUrl === normalizeDeviceTarget(targetUrl));
  const activeDeviceKey = activeSavedTarget?.deviceKey ?? null;
  const { data, deviceStatus, frontendTransportState, transportState, updatedAt, retry } = useDashboardData(
    targetUrl,
    activeDeviceKey,
    refreshIntervalMs,
    liveEnabled,
    handleLiveConfigUpdate,
    handleAuthRequired,
  );
  const i18n = React.useMemo(() => ({
    language,
    setLanguage: (nextLanguage: Language) => {
      setLanguageState(nextLanguage);
      writeLanguage(nextLanguage);
    },
    t: (key: TranslationKey) => translate(language, key),
  }), [language]);
  const stablePortStates = useStablePortRuntimeStates(data && data.source !== "mock" ? data.metrics.ports : []);

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

  async function handleMqttSettingsApply(nextConfig: { enabled: boolean; brokerUrl: string; username: string; password?: string }) {
    await runConnectionAction(async () => {
      const saved = await saveMqttConfig(nextConfig);
      setSavedTargets(saved.config.targets);
      setMqttConfig(saved.config.mqtt);
      setMqttStatus(saved.mqtt.status);
    });
  }

  async function handleMqttStream(enabled: boolean) {
    if (!activeDeviceKey) return;
    await runConnectionAction(async () => {
      await setMqttTelemetryStream(activeDeviceKey, enabled);
    });
  }

  async function handleMqttControl(action: MqttControlAction, params: Record<string, unknown> = {}) {
    if (!activeDeviceKey) return;
    await runConnectionAction(async () => {
      await sendMqttControl(activeDeviceKey, action, params);
    });
  }

  async function handleMqttQueryState(ports: number[]) {
    if (!activeDeviceKey) throw new Error("missing device key");
    const result = await fetchMqttControlState(activeDeviceKey, ports);
    return { state: result.state, errors: result.errors };
  }

  async function handlePortPower(port: number, enabled: boolean) {
    if (!activeDeviceKey) return;
    await runConnectionAction(async () => {
      await setMqttPortPower(activeDeviceKey, port, enabled);
    });
  }

  React.useEffect(() => {
    if (!serverSession || !serverSession.authenticated) return;
    const serverInterval = clampRefreshInterval(serverSession.config.refreshIntervalMs);
    setSavedTargets(serverSession.config.targets);
    setMqttConfig(serverSession.config.mqtt);
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

  React.useEffect(() => {
    if (!ready || passwordRequired) return;
    let alive = true;
    async function refreshMqttStatus() {
      try {
        const next = await fetchMqttStatus();
        if (!alive) return;
        setMqttConfig(next.config);
        setMqttStatus(next.status);
      } catch {
        // Non-critical; live device updates continue through SSE/HTTP fallback.
      }
    }
    void refreshMqttStatus();
    const timer = window.setInterval(refreshMqttStatus, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [ready, passwordRequired]);

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
  const historyDeviceKey = activeDeviceKey ?? (machineInfo.psn && machineInfo.psn !== "unknown" ? machineInfo.psn : null);
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
  const peakPortPower = Math.max(...metrics.ports.filter((port) => stablePortStates.get(port.id) === "attached").map(watts), 0);

  return (
    <I18nContext.Provider value={i18n}>
      <main className="app">
        <Header
          metrics={metrics}
          profile={activeProfile}
          deviceStatus={deviceStatus}
          frontendTransportState={frontendTransportState}
          source={source}
          transportState={transportState}
          targetUrl={targetUrl}
          refreshIntervalMs={refreshIntervalMs}
          savedTargets={savedTargets}
          mqttConfig={mqttConfig}
          mqttStatus={mqttStatus}
          activeDeviceKey={activeDeviceKey}
          updatedAt={updatedAt}
          connectionActionPending={connectionActionPending}
          onApply={handleConnectionSettingsApply}
          onMqttApply={handleMqttSettingsApply}
          onMqttStream={handleMqttStream}
          onMqttControl={handleMqttControl}
          onMqttQueryState={handleMqttQueryState}
          onSelectSavedTarget={handleSavedTargetSelect}
          onDeleteTarget={handleDeleteSavedTarget}
          onUpdateTargetNote={handleSavedTargetNoteUpdate}
        />
        <DeviceFace history={history} metrics={metrics} portStates={stablePortStates} profile={activeProfile} />
        {showAppearanceSwitcher ? (
          <ProfileSwitcher
            activeProfile={activeProfile}
            detectedProfile={detectedProfile}
            onChange={(profile) => setActiveProfileKey(profile.key)}
          />
        ) : null}
        <SummaryStrip heap={heap} metrics={metrics} profile={activeProfile} />
        <PortStateGuide />
        <section className="ports-grid" aria-label={i18n.t("portTelemetry")}>
          {metrics.ports.map((port) => (
            <PortCard
              key={port.id}
              port={port}
              runtimeState={stablePortStates.get(port.id)}
              isPeak={peakPortPower > 0 && watts(port) === peakPortPower}
              mqttEnabled={Boolean(mqttConfig?.enabled && mqttStatus?.connected && activeDeviceKey)}
              onSetPower={(enabled) => handlePortPower(port.id, enabled)}
            />
          ))}
        </section>
        <section className="dashboard-grid">
          <PowerChart history={history} source={source} transportState={transportState} />
          <RuntimePanel metrics={metrics} heap={heap} />
        </section>
        <LongHistoryPanel
          targetUrl={targetUrl}
          deviceKey={historyDeviceKey}
          isLive={source === "device"}
          metrics={metrics}
          ports={metrics.ports}
          updatedAt={updatedAt}
        />
        <DiagnosticsDeck heap={heap} history={history} machineInfo={machineInfo} metrics={metrics} targetUrl={targetUrl} deviceKey={historyDeviceKey} />
        <AppFooter />
      </main>
    </I18nContext.Provider>
  );
}

registerPwa();
createRoot(document.getElementById("root")!).render(<App />);
