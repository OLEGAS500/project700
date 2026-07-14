import { createHash } from "node:crypto";

export type BaselineMetricStatus =
  | "learning"
  | "ready_for_confirmation"
  | "active"
  | "stale"
  | "relearning";

export type BaselineObservation = {
  snapshotId: string;
  value: number;
  observedAt: string;
  comparable: boolean;
  configurationHash: string;
};

export type BaselineCalculationInput = {
  observations: BaselineObservation[];
  minSamples?: number;
  maxSamples?: number;
  wasConfirmed?: boolean;
};

export type BaselineCalculation = {
  status: BaselineMetricStatus;
  medianValue: number;
  minValue: number;
  maxValue: number;
  p10Value: number;
  p90Value: number;
  sampleCount: number;
  windowStartAt: string;
  windowEndAt: string;
  configurationHash: string;
  observationSnapshotIds: string[];
};

export function calculateBaseline(
  input: BaselineCalculationInput
): BaselineCalculation | null {
  const minSamples = input.minSamples ?? 7;
  const maxSamples = input.maxSamples ?? 14;
  const comparable = input.observations
    .filter((observation) => observation.comparable)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));

  if (comparable.length === 0) {
    return null;
  }

  const latestConfig = comparable[comparable.length - 1].configurationHash;
  const window = comparable
    .filter((observation) => observation.configurationHash === latestConfig)
    .slice(-maxSamples);
  const values = window.map((observation) => observation.value).sort((a, b) => a - b);
  const status =
    window.length >= minSamples
      ? input.wasConfirmed
        ? "active"
        : "ready_for_confirmation"
      : "learning";

  return {
    status,
    medianValue: percentile(values, 0.5),
    minValue: values[0],
    maxValue: values[values.length - 1],
    p10Value: percentile(values, 0.1),
    p90Value: percentile(values, 0.9),
    sampleCount: window.length,
    windowStartAt: window[0].observedAt,
    windowEndAt: window[window.length - 1].observedAt,
    configurationHash: latestConfig,
    observationSnapshotIds: window.map((observation) => observation.snapshotId)
  };
}

export function createBaselineConfigHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortObject(value))).digest("hex");
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const index = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortObject(nested)])
    );
  }

  return value;
}
