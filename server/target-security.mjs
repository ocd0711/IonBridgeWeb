import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const defaultAllowedTargets = "192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,*.local";

export function normalizeTarget(target) {
  const trimmed = String(target || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function createTargetFetcher({
  allowTargetRedirects,
  allowedTargets,
  maxTargetRedirects,
}) {
  const allowedTargetRules = parseAllowedTargetRules(allowedTargets);

  async function assertAllowedTargetUrl(input) {
    const url = new URL(input);
    if (url.protocol !== "http:") {
      throw new Error("target protocol is not allowed");
    }
    const hostname = normalizeHostname(url.hostname);
    if (!hostname) throw new Error("target host is required");
    if (matchesAllowedHostname(hostname, allowedTargetRules)) return;

    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) throw new Error("target host did not resolve");
    if (!addresses.every(({ address }) => isAllowedIpAddress(address, allowedTargetRules))) {
      throw new Error("target address is not allowed");
    }
  }

  return async function fetchTarget(input, options = {}) {
    let current = new URL(input);
    for (let redirectCount = 0; redirectCount <= maxTargetRedirects; redirectCount += 1) {
      await assertAllowedTargetUrl(current);
      const response = await fetch(current, { ...options, redirect: "manual" });
      if (!isRedirectStatus(response.status)) return response;
      const location = response.headers.get("location");
      if (!allowTargetRedirects || !location) {
        throw new Error("target redirect is not allowed");
      }
      if (redirectCount === maxTargetRedirects) {
        throw new Error("too many target redirects");
      }
      current = new URL(location, current);
    }
    throw new Error("too many target redirects");
  };
}

export function parseAllowedTargetRules(value) {
  const rawRules = String(value || defaultAllowedTargets)
    .split(",")
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
  return rawRules.map((rule) => {
    if (rule.startsWith("*.")) return { type: "suffix", value: rule.slice(1) };
    if (rule.includes("/")) {
      const [network, prefixText] = rule.split("/");
      const prefix = Number(prefixText);
      const networkInt = ipv4ToInt(network);
      if (networkInt == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(`invalid IONBRIDGE_ALLOWED_TARGETS rule: ${rule}`);
      }
      return { type: "cidr4", network: networkInt, mask: prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0 };
    }
    const ipInt = ipv4ToInt(rule);
    if (ipInt != null) return { type: "cidr4", network: ipInt, mask: 0xffffffff };
    return { type: "host", value: normalizeHostname(rule) };
  });
}

function matchesAllowedHostname(hostname, allowedTargetRules) {
  if (blockedHostnames().has(hostname)) return false;
  return allowedTargetRules.some((rule) => {
    if (rule.type === "host") return hostname === rule.value;
    if (rule.type === "suffix") return hostname.endsWith(rule.value) && hostname.length > rule.value.length;
    return false;
  });
}

function isAllowedIpAddress(address, allowedTargetRules) {
  const normalized = normalizeHostname(address);
  if (blockedHostnames().has(normalized)) return false;
  const ip4 = ipv4ToInt(normalized);
  if (ip4 != null) {
    if (isBlockedIpv4(ip4)) return false;
    return allowedTargetRules.some((rule) => rule.type === "cidr4" && (ip4 & rule.mask) === (rule.network & rule.mask));
  }
  return false;
}

function normalizeHostname(hostname) {
  return String(hostname || "").trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function blockedHostnames() {
  return new Set(["localhost", "0.0.0.0", "::", "::1"]);
}

function isBlockedIpv4(ip) {
  return (
    inIpv4Cidr(ip, "0.0.0.0", 8) ||
    inIpv4Cidr(ip, "127.0.0.0", 8) ||
    inIpv4Cidr(ip, "169.254.0.0", 16) ||
    inIpv4Cidr(ip, "224.0.0.0", 4) ||
    inIpv4Cidr(ip, "255.255.255.255", 32)
  );
}

function inIpv4Cidr(ip, network, prefix) {
  const networkInt = ipv4ToInt(network);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return networkInt != null && (ip & mask) === (networkInt & mask);
}

function ipv4ToInt(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const number = Number(part);
    if (number < 0 || number > 255) return null;
    result = ((result << 8) | number) >>> 0;
  }
  return result >>> 0;
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}
