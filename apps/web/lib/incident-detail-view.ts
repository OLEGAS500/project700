import type { IncidentStatus, IncidentType } from "@eim/core";

export function incidentContext(type: IncidentType): string | null {
  if (type !== "source_health") return null;

  return "This reports source verification health, such as an unavailable, partial, or blocked source. No conclusion has been made about product availability.";
}

export function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function statusTransitionLabel(
  fromStatus: IncidentStatus | null,
  toStatus: IncidentStatus | null
): string {
  if (fromStatus && toStatus) return `${formatIdentifier(fromStatus)} to ${formatIdentifier(toStatus)}`;
  if (toStatus) return `Changed to ${formatIdentifier(toStatus)}`;
  return "No lifecycle status change";
}

export function formatIdentifier(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
