import { evaluateFeedCatalogDropCandidate, getStore } from "@eim/db";
import { NextResponse } from "next/server";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const store = await getStore(id);

  if (!store) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  const body = await request.json();
  const snapshotId = typeof body.snapshotId === "string" ? body.snapshotId : null;

  if (!snapshotId) {
    return NextResponse.json({ error: "snapshotId is required" }, { status: 400 });
  }

  const candidate = await evaluateFeedCatalogDropCandidate(id, snapshotId);
  return NextResponse.json({ candidate });
}
