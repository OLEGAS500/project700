"use server";

import { emailDestinationInputSchema, telegramDestinationInputSchema } from "@eim/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { upsertEmailDestination, upsertTelegramDestination } from "@eim/db";

export type DestinationActionState = { error: string | null };

export async function upsertEmailDestinationAction(
  storeId: string,
  _previousState: DestinationActionState,
  formData: FormData
): Promise<DestinationActionState> {
  const parsed = emailDestinationInputSchema.safeParse({
    recipientEmails: formValue(formData, "recipientEmails")
      .split(/\r?\n/)
      .map((email) => email.trim())
      .filter(Boolean),
    enabled: checkboxValue(formData, "emailEnabled")
  });

  if (!parsed.success) return { error: "Enter at least one valid, unique email address." };

  try {
    await upsertEmailDestination(storeId, parsed.data);
  } catch {
    return { error: "The email destination could not be saved." };
  }

  revalidateDestinationViews(storeId);
  redirect(`/stores/${storeId}/destinations`);
}

export async function upsertTelegramDestinationAction(
  storeId: string,
  _previousState: DestinationActionState,
  formData: FormData
): Promise<DestinationActionState> {
  const parsed = telegramDestinationInputSchema.safeParse({
    chatId: formValue(formData, "chatId"),
    threadId: numberOrNull(formValue(formData, "threadId")),
    displayName: formValue(formData, "displayName").trim() || null,
    enabled: checkboxValue(formData, "telegramEnabled")
  });

  if (!parsed.success) return { error: "Enter a valid Telegram chat and optional thread details." };

  try {
    await upsertTelegramDestination(storeId, parsed.data);
  } catch {
    return { error: "The Telegram destination could not be saved." };
  }

  revalidateDestinationViews(storeId);
  redirect(`/stores/${storeId}/destinations`);
}

function revalidateDestinationViews(storeId: string): void {
  revalidatePath(`/stores/${storeId}/destinations`);
  revalidatePath("/dashboard");
}

function checkboxValue(formData: FormData, name: string): boolean {
  return formData.get(name) === "on";
}

function numberOrNull(raw: string): number | null {
  const value = raw.trim();
  return value ? Number(value) : null;
}

function formValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
