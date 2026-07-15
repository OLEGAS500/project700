"use server";

import { createMaintenanceWindowInputSchema } from "@eim/core";
import { cancelMaintenanceWindow, createMaintenanceWindow, MaintenanceWindowNotFoundError } from "@eim/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export type MaintenanceActionState = { error: string | null };

export async function createMaintenanceWindowAction(
  storeId: string,
  _previousState: MaintenanceActionState,
  formData: FormData
): Promise<MaintenanceActionState> {
  const parsed = createMaintenanceWindowInputSchema.safeParse({
    startsAt: formValue(formData, "startsAt"),
    endsAt: formValue(formData, "endsAt"),
    reason: formValue(formData, "reason"),
    createdBy: formValue(formData, "createdBy")
  });
  if (!parsed.success) return { error: "Enter valid dates, a reason, and who created this window." };

  try {
    await createMaintenanceWindow(storeId, parsed.data);
  } catch {
    return { error: "The maintenance window could not be created." };
  }

  revalidateMaintenanceViews(storeId);
  redirect(`/stores/${storeId}/maintenance`);
}

export async function cancelMaintenanceWindowAction(
  storeId: string,
  windowId: string
): Promise<MaintenanceActionState> {
  try {
    await cancelMaintenanceWindow(storeId, windowId);
  } catch (error) {
    if (error instanceof MaintenanceWindowNotFoundError) {
      return { error: "This maintenance window no longer exists." };
    }
    return { error: "The maintenance window could not be cancelled." };
  }

  revalidateMaintenanceViews(storeId);
  redirect(`/stores/${storeId}/maintenance`);
}

function revalidateMaintenanceViews(storeId: string): void {
  revalidatePath(`/stores/${storeId}/maintenance`);
  revalidatePath("/dashboard");
}

function formValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
