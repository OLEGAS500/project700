import { confirmFeedCatalogDropCandidate } from "@eim/db";
import { NextResponse } from "next/server";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = await request.json();
  const confirmationSnapshotId =
    typeof body.confirmationSnapshotId === "string" ? body.confirmationSnapshotId : null;

  if (!confirmationSnapshotId) {
    return NextResponse.json(
      { error: "confirmationSnapshotId is required" },
      { status: 400 }
    );
  }

  const result = await confirmFeedCatalogDropCandidate(id, confirmationSnapshotId);
  return NextResponse.json(result);
}
