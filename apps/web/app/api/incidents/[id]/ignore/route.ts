import { ignoreIncidentInputSchema } from "@eim/core";
import { ignoreIncident } from "@eim/db";
import { NextResponse } from "next/server";
import { incidentErrorResponse } from "../../response";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = ignoreIncidentInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid ignore payload", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const incident = await ignoreIncident(id, parsed.data);
    return NextResponse.json({ incident });
  } catch (error) {
    return incidentErrorResponse(error);
  }
}
