import { getStore } from "@eim/db";
import { runSourceSnapshotForStore } from "@eim/worker";
import { NextResponse } from "next/server";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const store = await getStore(id);

  if (!store) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  const snapshot = await runSourceSnapshotForStore(id);

  return NextResponse.json({ snapshot });
}
