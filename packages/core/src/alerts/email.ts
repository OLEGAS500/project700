import type { CanonicalAlertPayload } from "./payload";

export type RenderedEmailAlert = {
  subject: string;
  text: string;
};

export function renderEmailAlert(payload: CanonicalAlertPayload): RenderedEmailAlert {
  const state =
    payload.alertType === "incident_resolved"
      ? "Resolved"
      : payload.alertType === "incident_worsened"
        ? "Worsened"
        : "New incident";
  const subject = `[${state}] ${payload.store.name}: ${payload.incident.title}`;
  const lines = [
    payload.incident.title,
    `Store: ${payload.store.name} (${payload.store.domain})`,
    `Status: ${payload.incident.status}`,
    `Affected: ${payload.incident.affectedCount}`,
    payload.incident.summary
  ];

  for (const metric of payload.metrics) {
    if (metric.beforeValue === null && metric.afterValue === null) continue;
    lines.push(
      `${metric.name}: ${metric.beforeValue ?? "unknown"} -> ${metric.afterValue ?? "unknown"}${metric.unit ? ` ${metric.unit}` : ""}`
    );
  }

  return { subject: subject.slice(0, 200), text: lines.join("\n") };
}
