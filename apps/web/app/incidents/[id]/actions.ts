"use server";

import {
  acknowledgeIncidentInputSchema,
  addIncidentCommentInputSchema,
  ignoreIncidentInputSchema
} from "@eim/core";
import {
  acknowledgeIncident,
  addIncidentComment,
  ignoreIncident,
  IncidentActionConflictError,
  IncidentNotFoundError
} from "@eim/db";
import { redirect } from "next/navigation";
import { revalidateIncidentViews } from "./view-cache";

export type IncidentActionState = {
  error: string | null;
};

export async function acknowledgeIncidentAction(
  incidentId: string,
  _previousState: IncidentActionState,
  formData: FormData
): Promise<IncidentActionState> {
  const parsed = acknowledgeIncidentInputSchema.safeParse({
    actor: formValue(formData, "actor"),
    comment: optionalFormValue(formData, "comment")
  });

  if (!parsed.success) return { error: "Enter your name before acknowledging this incident." };

  try {
    await acknowledgeIncident(incidentId, parsed.data);
  } catch (error) {
    return { error: actionErrorMessage(error, "The incident could not be acknowledged.") };
  }

  revalidateIncidentViews(incidentId, { summariesChanged: true });
  redirect(`/incidents/${incidentId}`);
}

export async function ignoreIncidentAction(
  incidentId: string,
  _previousState: IncidentActionState,
  formData: FormData
): Promise<IncidentActionState> {
  const parsed = ignoreIncidentInputSchema.safeParse({
    actor: formValue(formData, "actor"),
    reason: formValue(formData, "reason")
  });

  if (!parsed.success) return { error: "Enter your name and a reason before ignoring this incident." };

  try {
    await ignoreIncident(incidentId, parsed.data);
  } catch (error) {
    return { error: actionErrorMessage(error, "The incident could not be ignored.") };
  }

  revalidateIncidentViews(incidentId, { summariesChanged: true });
  redirect(`/incidents/${incidentId}`);
}

export async function addIncidentCommentAction(
  incidentId: string,
  _previousState: IncidentActionState,
  formData: FormData
): Promise<IncidentActionState> {
  const parsed = addIncidentCommentInputSchema.safeParse({
    actor: formValue(formData, "actor"),
    body: formValue(formData, "body")
  });

  if (!parsed.success) return { error: "Enter your name and a comment before submitting." };

  try {
    await addIncidentComment(incidentId, parsed.data);
  } catch (error) {
    return { error: actionErrorMessage(error, "The comment could not be added.") };
  }

  revalidateIncidentViews(incidentId, { summariesChanged: false });
  redirect(`/incidents/${incidentId}`);
}

function formValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function optionalFormValue(formData: FormData, name: string): string | undefined {
  const value = formValue(formData, name).trim();
  return value || undefined;
}

function actionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof IncidentActionConflictError) {
    return "This action is no longer available because the incident status changed.";
  }

  if (error instanceof IncidentNotFoundError) {
    return "This incident no longer exists.";
  }

  return fallback;
}
