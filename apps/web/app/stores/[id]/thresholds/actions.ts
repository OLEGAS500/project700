"use server";

import { updateStoreThresholdsInputSchema } from "@eim/core";
import { StoreThresholdsNotFoundError, updateStoreThresholds } from "@eim/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export type ThresholdActionState = { error: string | null };

export async function updateStoreThresholdsAction(
  storeId: string,
  _previousState: ThresholdActionState,
  formData: FormData
): Promise<ThresholdActionState> {
  const parsed = updateStoreThresholdsInputSchema.safeParse({
    catalogDropPercentage: percentageValue(formData, "catalogDropPercentage"),
    catalogDropAbsolute: integerValue(formData, "catalogDropAbsolute"),
    sourceDivergencePercentage: percentageValue(formData, "sourceDivergencePercentage"),
    sourceDivergenceAbsolute: integerValue(formData, "sourceDivergenceAbsolute"),
    priceMismatchTolerance: {
      absolute: numberValue(formData, "priceMismatchAbsolute"),
      relative: percentageValue(formData, "priceMismatchRelative")
    },
    minimumMismatchCount: integerValue(formData, "minimumMismatchCount"),
    minimumMismatchRatio: percentageValue(formData, "minimumMismatchRatio"),
    seoCoverageMinimum: percentageValue(formData, "seoCoverageMinimum"),
    sourceHealthConsecutiveFailures: integerValue(formData, "sourceHealthConsecutiveFailures")
  });

  if (!parsed.success) return { error: "Enter valid threshold values before saving." };

  try {
    await updateStoreThresholds(storeId, parsed.data);
  } catch (error) {
    if (error instanceof StoreThresholdsNotFoundError) {
      return { error: "Threshold settings for this store no longer exist." };
    }
    return { error: "The threshold settings could not be saved." };
  }

  revalidatePath(`/stores/${storeId}/thresholds`);
  redirect(`/stores/${storeId}/thresholds`);
}

function numberValue(formData: FormData, name: string): number {
  const raw = formValue(formData, name).trim();
  return raw ? Number(raw) : Number.NaN;
}

function integerValue(formData: FormData, name: string): number {
  return numberValue(formData, name);
}

function percentageValue(formData: FormData, name: string): number {
  return numberValue(formData, name) / 100;
}

function formValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
