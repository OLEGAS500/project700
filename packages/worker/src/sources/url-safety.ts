import { isIP } from "node:net";

const blockedHostnames = new Set(["localhost", "metadata.google.internal"]);

export function assertPublicHttpUrl(url: string): void {
  const parsed = new URL(url);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("URL must use http or https");
  }

  const hostname = parsed.hostname.toLowerCase();

  if (blockedHostnames.has(hostname)) {
    throw new Error(`Blocked internal hostname: ${hostname}`);
  }

  const ipVersion = isIP(hostname);

  if (ipVersion === 4 && isBlockedIpv4(hostname)) {
    throw new Error(`Blocked private IPv4 address: ${hostname}`);
  }

  if (ipVersion === 6 && isBlockedIpv6(hostname)) {
    throw new Error(`Blocked private IPv6 address: ${hostname}`);
  }
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;

  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 0
  );
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:169.254.")
  );
}
