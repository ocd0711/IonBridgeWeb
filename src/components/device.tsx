import React, { useEffect, useRef, useState } from "react";

import type { DeviceVisualProfile } from "../deviceProfiles";
import { portLabel, portRuntimeState, watts, type PortRuntimeState } from "../format";
import { useI18n } from "../i18n";
import type { Metrics, PortHistory, PortMetrics } from "../types";

function samplePower(sample: { voltage: number; current: number }) {
  return (sample.voltage * sample.current) / 1_000_000;
}

function peakTotalPower(history: PortHistory) {
  const totalsByTime = new Map<number, number>();
  const totalsByIndex = new Map<number, number>();
  for (const port of history.ports) {
    port.samples.forEach((sample, index) => {
      const power = samplePower(sample);
      if (Number.isFinite(sample.ts)) {
        const second = Math.round((sample.ts as number) / 1000);
        totalsByTime.set(second, (totalsByTime.get(second) ?? 0) + power);
      } else {
        totalsByIndex.set(index, (totalsByIndex.get(index) ?? 0) + power);
      }
    });
  }

  return Math.max(0, ...totalsByTime.values(), ...totalsByIndex.values());
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
  const peakPower = Math.max(totalPower, peakTotalPower(history));
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

export function DeviceFace({
  metrics,
  history,
  profile,
  portStates,
}: {
  metrics: Metrics;
  history: PortHistory;
  profile: DeviceVisualProfile;
  portStates?: Map<number, PortRuntimeState>;
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
                  <DevicePort key={port.id} port={port} runtimeState={portStates?.get(port.id)} />
                ))}
              </div>
            </div>
          </div>
          {sidePorts.length > 0 ? (
            <div className="side-port-dock">
              {sidePorts.map((port) => (
                <SidePortFace key={port.id} port={port} profile={profile} runtimeState={portStates?.get(port.id)} />
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

function DevicePort({ port, runtimeState = portRuntimeState(port) }: { port: PortMetrics; runtimeState?: PortRuntimeState }) {
  const { t } = useI18n();
  const isA = port.port_type === "A";
  const power = watts(port);
  const powerStrength = Math.max(0.18, Math.min(1, power / Math.max(port.power_budget || 1, 1)));
  const stateLabel = {
    attached: t("portAttachedShort"),
    fault: t("portFaultShort"),
    "no-power": t("portNoPowerShort"),
    off: t("portOffShort"),
    protecting: t("portProtectingShort"),
    ready: t("portReadyShort"),
    recovering: t("portRecoveringShort"),
    switching: t("portSwitchingShort"),
  }[runtimeState];

  return (
    <div
      className={`device-port ${isA ? "type-a" : "type-c"} ${runtimeState}`}
      style={{
        "--port-energy": runtimeState === "attached"
          ? powerStrength
          : runtimeState === "no-power" || runtimeState === "protecting" || runtimeState === "recovering"
            ? 0.08
            : 0,
      } as React.CSSProperties}
    >
      <div className="port-hole">
        <span />
      </div>
      <strong>{portLabel(port)}</strong>
      <small>{power.toFixed(1)}W</small>
      <span className="device-port-state"><i />{stateLabel}</span>
    </div>
  );
}

function SidePortFace({ port, profile, runtimeState }: { port: PortMetrics; profile: DeviceVisualProfile; runtimeState?: PortRuntimeState }) {
  const { t } = useI18n();
  return (
    <aside className="side-port-face" aria-label={t("sideC4")}>
      <div className="side-seam" />
      <div className="side-brand">{profile.sidePortLabel}</div>
      <DevicePort port={port} runtimeState={runtimeState} />
      <div className="side-caption">SIDE PORT</div>
    </aside>
  );
}
