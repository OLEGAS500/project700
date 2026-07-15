import { InvalidDashboardCursorError, listDashboardIncidents } from "@eim/db";
import { NextResponse } from "next/server";
import { parseDashboardIncidentQuery } from "../../../lib/dashboard-incident-query";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = parseDashboardIncidentQuery(url.searchParams);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error, ...("issues" in parsed ? { issues: parsed.issues } : {}) },
      { status: 400 }
    );
  }

  try {
    const result = await listDashboardIncidents(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof InvalidDashboardCursorError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
