export function normalizeUrlForKey(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}

export function normalizeDomain(domain: string): string {
  const parsed = new URL(domain);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "";
  return parsed.toString().replace(/\/$/, "");
}
