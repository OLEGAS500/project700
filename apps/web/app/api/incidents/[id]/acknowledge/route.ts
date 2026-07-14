import { acknowledgeIncidentInputSchema } from "@eim/core";
import { acknowledgeIncident } from "@eim/db";
import { NextResponse } from "next/server";
import { incidentErrorResponse } from "../../response";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = acknowledgeIncidentInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid acknowledge payload", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const incident = await acknowledgeIncident(id, parsed.data);
    return NextResponse.json({ incident });
  } catch (error) {
    return incidentErrorResponse(error);
  }
}
