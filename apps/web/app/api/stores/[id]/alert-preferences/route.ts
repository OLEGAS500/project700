import { updateAlertPreferencesInputSchema } from "@eim/core";
import { getAlertPreferences, getStore, updateAlertPreferences } from "@eim/db";
import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!(await getStore(id))) return NextResponse.json({ error: "Store not found" }, { status: 404 });
  return NextResponse.json({ preferences: await getAlertPreferences(id) });
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!(await getStore(id))) return NextResponse.json({ error: "Store not found" }, { status: 404 });
  const parsed = updateAlertPreferencesInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid alert preference payload", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }
  return NextResponse.json({ preferences: await updateAlertPreferences(id, parsed.data) });
}
