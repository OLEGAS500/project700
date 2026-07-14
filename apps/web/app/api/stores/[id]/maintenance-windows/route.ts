import { createMaintenanceWindowInputSchema } from "@eim/core";
import {
  createMaintenanceWindow,
  getStore,
  listMaintenanceWindows
} from "@eim/db";
import { NextResponse } from "next/server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const store = await getStore(id);

  if (!store) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  const maintenanceWindows = await listMaintenanceWindows(id);
  return NextResponse.json({ maintenanceWindows });
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const store = await getStore(id);

  if (!store) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsed = createMaintenanceWindowInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid maintenance window payload", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const maintenanceWindow = await createMaintenanceWindow(id, parsed.data);
  return NextResponse.json({ maintenanceWindow }, { status: 201 });
}
