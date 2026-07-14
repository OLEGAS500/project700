export type ObservedField =
  | "httpStatus"
  | "indexability"
  | "canonicalUrl"
  | "schemaPresent"
  | "price"
  | "availability"
  | "imageUrl";

export type FieldObservation = {
  sourceCheckStatus: "success" | "partial" | "timeout" | "blocked" | "authentication_failed" | "parse_failed" | "source_unavailable";
  value: unknown;
  extractionSucceeded?: boolean;
};

export function canCompareField(
  field: ObservedField,
  previous: FieldObservation,
  current: FieldObservation
): boolean {
  if (!isComparableCheck(previous) || !isComparableCheck(current)) {
    return false;
  }

  if (previous.extractionSucceeded === false || current.extractionSucceeded === false) {
    return false;
  }

  if (field === "httpStatus") {
    return previous.value !== undefined && current.value !== undefined;
  }

  return previous.value !== undefined && current.value !== undefined;
}

function isComparableCheck(observation: FieldObservation): boolean {
  return observation.sourceCheckStatus === "success" || observation.sourceCheckStatus === "partial";
}
