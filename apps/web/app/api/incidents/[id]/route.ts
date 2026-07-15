import { getDashboardIncidentDetail } from "@eim/db";
import { NextResponse } from "next/server";
import { z } from "zod";

const incidentIdSchema = z.string().uuid();

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const incidentId = incidentIdSchema.safeParse(id);

  if (!incidentId.success) {
    return NextResponse.json({ error: "Incident id must be a UUID" }, { status: 400 });
  }

  const incident = await getDashboardIncidentDetail(incidentId.data);

  if (!incident) {
    return NextResponse.json({ error: "Incident not found" }, { status: 404 });
  }

  return NextResponse.json(incident);
}
