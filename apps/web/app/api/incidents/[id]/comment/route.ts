import { addIncidentCommentInputSchema } from "@eim/core";
import { addIncidentComment } from "@eim/db";
import { NextResponse } from "next/server";
import { incidentErrorResponse } from "../../response";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const parsed = addIncidentCommentInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid comment payload", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const comment = await addIncidentComment(id, parsed.data);
    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    return incidentErrorResponse(error);
  }
}
