import type { CanonicalAlertMetric, CanonicalAlertPayload } from "./payload";

const maxTelegramMessageLength = 3_900;

export type RenderedTelegramAlert = {
  text: string;
  parseMode: "HTML";
};

export function renderTelegramAlert(
  payload: CanonicalAlertPayload
): RenderedTelegramAlert {
  const lines =
    payload.alertType === "incident_resolved"
      ? renderResolved(payload)
      : payload.incident.type === "source_health"
        ? renderSourceHealth(payload)
        : renderBusinessIncident(payload);

  return {
    text: fitTelegramMessage(lines),
    parseMode: "HTML"
  };
}

function renderBusinessIncident(payload: CanonicalAlertPayload): string[] {
  const heading =
    payload.alertType === "incident_worsened"
      ? `Incident worsened: ${incidentTypeLabel(payload.incident.type)}`
      : payload.incident.type === "catalog_drop"
        ? "Catalog drop detected"
        : payload.incident.title;
  const lines = [
    `<b>🔴 ${escapeHtml(truncate(heading, 180))}</b>`,
    renderStore(payload),
    `<b>Affected:</b> ${payload.incident.affectedCount}`
  ];

  appendMetrics(lines, payload.metrics);
  if (payload.incident.confidenceScore !== null) {
    lines.push(`<b>Confidence:</b> ${formatConfidence(payload.incident.confidenceScore)}`);
  }
  if (payload.incident.likelySource) {
    lines.push(`<b>Likely source:</b> ${escapeHtml(truncate(payload.incident.likelySource, 120))}`);
  }
  appendEvidenceAndSamples(lines, payload);
  return lines;
}

function renderSourceHealth(payload: CanonicalAlertPayload): string[] {
  const heading =
    payload.alertType === "incident_worsened"
      ? "Feed monitoring failure worsened"
      : "Feed monitoring failure";
  const failureMetric = payload.metrics.find(
    (metric) => metric.name === "source_check_failure_count"
  );
  const sourceStatus = payload.event.reason ?? sourceStatusFromEvidence(payload.evidence);
  const lines = [
    `<b>⚠️ ${heading}</b>`,
    renderStore(payload),
    escapeHtml(truncate(payload.incident.summary, 500)),
    "<b>Products are not confirmed missing.</b>"
  ];

  if (sourceStatus) {
    lines.push(`<b>Status:</b> ${escapeHtml(truncate(sourceStatus, 180))}`);
  }
  if (failureMetric?.afterValue !== null && failureMetric?.afterValue !== undefined) {
    lines.push(`<b>Consecutive failures:</b> ${escapeHtml(failureMetric.afterValue)}`);
  }
  appendEvidenceAndSamples(lines, payload);
  return lines;
}

function sourceStatusFromEvidence(evidence: string[]): string | null {
  const prefix = "feed source check returned ";
  const statusEvidence = evidence.find((item) => item.toLowerCase().startsWith(prefix));
  return statusEvidence ? statusEvidence.slice(prefix.length).trim() || null : null;
}

function renderResolved(payload: CanonicalAlertPayload): string[] {
  const lines = [
    "<b>✅ Incident resolved</b>",
    renderStore(payload),
    `<b>Incident:</b> ${escapeHtml(truncate(incidentTypeLabel(payload.incident.type), 180))}`,
    escapeHtml(truncate(payload.incident.summary, 500))
  ];

  appendMetrics(lines, payload.metrics);
  if (payload.event.reason) {
    lines.push(`<b>Recovery:</b> ${escapeHtml(truncate(payload.event.reason, 300))}`);
  }
  return lines;
}

function renderStore(payload: CanonicalAlertPayload): string {
  return `<b>Store:</b> ${escapeHtml(truncate(payload.store.name, 120))} (${escapeHtml(
    truncate(payload.store.domain, 200)
  )})`;
}

function appendMetrics(lines: string[], metrics: CanonicalAlertMetric[]): void {
  for (const metric of metrics.slice(0, 6)) {
    if (metric.beforeValue === null && metric.afterValue === null) continue;
    const before = metric.beforeValue ?? "unknown";
    const after = metric.afterValue ?? "unknown";
    const unit = metric.unit ? ` ${metric.unit}` : "";
    lines.push(
      `<b>${escapeHtml(metricLabel(metric.name))}:</b> ${escapeHtml(before)} → ${escapeHtml(after)}${escapeHtml(unit)}`
    );
  }
}

function appendEvidenceAndSamples(
  lines: string[],
  payload: CanonicalAlertPayload
): void {
  const evidence = payload.evidence.slice(0, 3);
  if (evidence.length > 0) {
    lines.push("", "<b>Evidence</b>");
    for (const item of evidence) {
      lines.push(`• ${escapeHtml(truncate(item, 280))}`);
    }
  }

  const samples = payload.samples.slice(0, 5);
  if (samples.length > 0) {
    lines.push("", "<b>Examples</b>");
    for (const sample of samples) {
      const label = sample.title ?? sample.offerId ?? sample.stableKey ?? sample.url ?? "Product";
      const url = sample.url ? ` — ${sample.url}` : "";
      lines.push(`• ${escapeHtml(truncate(`${label}${url}`, 300))}`);
    }
  }
}

function fitTelegramMessage(lines: string[]): string {
  const accepted: string[] = [];
  const suffix = "\n...";

  for (const line of lines) {
    const candidate = [...accepted, line].join("\n");
    if (candidate.length + suffix.length > maxTelegramMessageLength) {
      return `${accepted.join("\n")}${suffix}`;
    }
    accepted.push(line);
  }

  return accepted.join("\n");
}

function incidentTypeLabel(type: CanonicalAlertPayload["incident"]["type"]): string {
  const labels: Record<CanonicalAlertPayload["incident"]["type"], string> = {
    catalog_drop: "Catalog drop",
    source_divergence: "Storefront and feed divergence",
    seo_regression: "SEO regression",
    price_availability_mismatch: "Product data mismatch",
    source_health: "Feed monitoring failure",
    merchant_item_issues: "Merchant Center item issues"
  };
  return labels[type];
}

function metricLabel(metric: string): string {
  return metric
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
