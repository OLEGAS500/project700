import { confirmBaselineMetric } from "@eim/db";
import { NextResponse } from "next/server";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const userId =
    typeof body.userId === "string" && body.userId.trim()
      ? body.userId.trim()
      : "00000000-0000-0000-0000-000000000000";

  const baseline = await confirmBaselineMetric(id, userId);
  return NextResponse.json({ baseline });
}
