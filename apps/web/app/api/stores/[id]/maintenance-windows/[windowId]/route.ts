import {
  cancelMaintenanceWindow,
  MaintenanceWindowConflictError,
  MaintenanceWindowNotFoundError
} from "@eim/db";
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
    if (error instanceof MaintenanceWindowConflictError) {
      return NextResponse.json(
        { error: "This maintenance window can no longer be cancelled." },
        { status: 409 }
      );
    }
    throw error;
  }
}
