export type Language = "zh" | "en";

const DEVICE_TARGET_STORAGE_KEY = "ionbridge:device-target:v1";
const REFRESH_INTERVAL_STORAGE_KEY = "ionbridge:refresh-interval:v1";
const LANGUAGE_STORAGE_KEY = "ionbridge:language:v1";
const DEFAULT_REFRESH_INTERVAL_MS = 30000;

export function readDeviceTarget() {
  try {
    return localStorage.getItem(DEVICE_TARGET_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeDeviceTarget(targetUrl: string) {
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

export function readRefreshInterval() {
  try {
    const stored = Number(localStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 1000 ? stored : DEFAULT_REFRESH_INTERVAL_MS;
  } catch {
    return DEFAULT_REFRESH_INTERVAL_MS;
  }
}

export function writeRefreshInterval(intervalMs: number) {
  try {
    localStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(intervalMs));
  } catch {
    // Non-critical. The current session still uses the configured interval.
  }
}

export function readLanguage(): Language {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

export function writeLanguage(language: Language) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Non-critical. The current session still uses the selected language.
  }
}

export function clampRefreshInterval(intervalMs: number) {
  return Math.max(1000, Math.min(60000, Math.round(intervalMs)));
}
