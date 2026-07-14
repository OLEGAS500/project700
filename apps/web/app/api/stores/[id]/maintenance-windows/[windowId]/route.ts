import { cancelMaintenanceWindow, MaintenanceWindowNotFoundError } from "@eim/db";
import { NextResponse } from "next/server";

type RouteContext = {
  params: Promise<{ id: string; windowId: string }>;
};

export async function DELETE(_request: Request, context: RouteContext) {
  const { id, windowId } = await context.params;

  try {
    const maintenanceWindow = await cancelMaintenanceWindow(id, windowId);
    return NextResponse.json({ maintenanceWindow });
  } catch (error) {
    if (error instanceof MaintenanceWindowNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
