import { IncidentActionConflictError, IncidentNotFoundError } from "@eim/db";
import { NextResponse } from "next/server";

export function incidentErrorResponse(error: unknown) {
  if (error instanceof IncidentNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }

  if (error instanceof IncidentActionConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  throw error;
}
