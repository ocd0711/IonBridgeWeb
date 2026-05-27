import type { MachineInfo, PortMetrics } from "./types";

export type DeviceVisualProfile = {
  key: string;
  family: string;
  variant: "pro" | "ultra";
  displayName: string;
  powerLabel: string;
  totalPowerBudgetW: number;
  frontPortIds: number[];
  sidePortIds: number[];
  sidePortLabel: string;
  themeClass: string;
  displayKind: "amber" | "led";
  badgeStyle: "solid" | "outline";
};

export const deviceProfiles: DeviceVisualProfile[] = [
  {
    key: "cp02-pro",
    family: "CP02",
    variant: "pro",
    displayName: "小电拼 CP-02 Pro",
    powerLabel: "FluxAI inside, 160W",
    totalPowerBudgetW: 160,
    frontPortIds: [0, 1, 2, 3],
    sidePortIds: [4],
    sidePortLabel: "140W Max",
    themeClass: "theme-cp02-pro",
    displayKind: "led",
    badgeStyle: "outline",
  },
  {
    key: "cp02-ultra",
    family: "CP02",
    variant: "ultra",
    displayName: "小电拼 CP-02 Ultra",
    powerLabel: "FluxAI inside, 160W",
    totalPowerBudgetW: 160,
    frontPortIds: [0, 1, 2, 3],
    sidePortIds: [4],
    sidePortLabel: "140W Max",
    themeClass: "theme-cp02-ultra",
    displayKind: "led",
    badgeStyle: "solid",
  },
  {
    key: "cp02s-pro",
    family: "CP02s",
    variant: "pro",
    displayName: "小电拼 Mirror 02S Pro",
    powerLabel: "FluxAI inside, 160W",
    totalPowerBudgetW: 160,
    frontPortIds: [0, 1, 2, 3],
    sidePortIds: [4],
    sidePortLabel: "140W Max",
    themeClass: "theme-cp02s-pro",
    displayKind: "amber",
    badgeStyle: "outline",
  },
  {
    key: "cp02s-ultra",
    family: "CP02s",
    variant: "ultra",
    displayName: "小电拼 Mirror 02S Ultra",
    powerLabel: "FluxAI inside, 160W",
    totalPowerBudgetW: 160,
    frontPortIds: [0, 1, 2, 3],
    sidePortIds: [4],
    sidePortLabel: "140W Max",
    themeClass: "theme-cp02s-ultra",
    displayKind: "amber",
    badgeStyle: "solid",
  },
];

export function resolveDeviceProfile(
  machineInfo: MachineInfo,
  ports: PortMetrics[],
): DeviceVisualProfile {
  const variant = machineInfo.device_model?.toLowerCase();
  const profile = deviceProfiles.find(
    (item) => item.family === machineInfo.product_family && item.variant === variant,
  ) ?? deviceProfiles.find((item) => item.family === machineInfo.product_family);

  if (profile) {
    return profile;
  }

  return {
    key: "unknown",
    family: machineInfo.product_family || "Unknown",
    variant: "pro",
    displayName: machineInfo.device_name || machineInfo.product_family || "IonBridge",
    powerLabel: "FluxAI inside",
    totalPowerBudgetW: 160,
    frontPortIds: ports.map((port) => port.id),
    sidePortIds: [],
    sidePortLabel: "",
    themeClass: "theme-generic",
    displayKind: "amber",
    badgeStyle: "solid",
  };
}
