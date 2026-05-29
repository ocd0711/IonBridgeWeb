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
  login,
  normalizeDeviceTarget,
  saveServerConfig,
  setActiveServerTarget,
  deleteSavedTarget,
  updateSavedTargetNote,
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
import { useDashboardData, type DashboardData, type DeviceStatus, type LiveTransportState } from "./hooks/useDashboardData";
import { DeviceFace } from "./components/device";
import { DiagnosticsDeck } from "./components/diagnostics";
import { LongHistoryPanel, PowerChart } from "./components/history";
import {
  I18nContext,
  LanguageToggle,
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
  deviceStatus: DeviceStatus;
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
  const hottest = maxTemperature(metrics.ports.map((port) => port.die_temperature));
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
}: {
  port: PortMetrics;
  runtimeState?: PortRuntimeState;
  isPeak?: boolean;
}) {
  const { t } = useI18n();
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
  const [savedTargets, setSavedTargets] = React.useState<SavedTarget[]>([]);
  const { ready, passwordRequired, serverSession, setPasswordRequired, setServerSession } = useServerSettings();
  const [activeProfileKey, setActiveProfileKey] = React.useState<string | null>(null);
  const [connectionActionPending, setConnectionActionPending] = React.useState(false);
  const connectionActionPendingRef = React.useRef(false);
  const handleLiveConfigUpdate = React.useCallback((nextConfig: ServerSession["config"]) => {
    setSavedTargets(nextConfig.targets);
    setShowAppearanceSwitcher(Boolean(nextConfig.showAppearanceSwitcher));
  }, []);
  const handleAuthRequired = React.useCallback(() => {
    setPasswordRequired(true);
    setServerSession((current) => current ? { ...current, authenticated: false } : current);
  }, [setPasswordRequired, setServerSession]);
  const liveEnabled = ready && !passwordRequired;
  const activeSavedTarget = savedTargets.find((target) => target.targetUrl === normalizeDeviceTarget(targetUrl));
  const activeDeviceKey = activeSavedTarget?.deviceKey ?? null;
  const { data, deviceStatus, transportState, updatedAt, retry } = useDashboardData(
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
