"use server";

import { updateAlertPreferencesInputSchema } from "@eim/core";
import { updateAlertPreferences } from "@eim/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { percentageToDecimal } from "../../../../lib/decimal";

export type AlertPreferencesActionState = { error: string | null };

export async function updateAlertPreferencesAction(
  storeId: string,
  _previousState: AlertPreferencesActionState,
  formData: FormData
): Promise<AlertPreferencesActionState> {
  const parsed = updateAlertPreferencesInputSchema.safeParse({
    enabled: checkboxValue(formData, "enabled"),
    emailEnabled: checkboxValue(formData, "emailEnabled"),
    telegramEnabled: checkboxValue(formData, "telegramEnabled"),
    mutedIncidentTypes: formData
      .getAll("mutedIncidentTypes")
      .filter((value): value is string => typeof value === "string"),
    notifyOnOpen: checkboxValue(formData, "notifyOnOpen"),
    notifyOnWorsening: checkboxValue(formData, "notifyOnWorsening"),
    notifyOnRecovery: checkboxValue(formData, "notifyOnRecovery"),
    worseningAffectedCountPercent: percentageToDecimal(formValue(formData, "worseningAffectedCountPercent")),
    worseningSeverityIncrease: checkboxValue(formData, "worseningSeverityIncrease")
  });

  if (!parsed.success) return { error: "Enter valid alert preference values before saving." };

  try {
    await updateAlertPreferences(storeId, parsed.data);
  } catch {
    return { error: "The alert preferences could not be saved." };
  }

  revalidatePath(`/stores/${storeId}/alert-preferences`);
  revalidatePath("/dashboard");
  redirect(`/stores/${storeId}/alert-preferences`);
}

function checkboxValue(formData: FormData, name: string): boolean {
  return formData.get(name) === "on";
}

function formValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
