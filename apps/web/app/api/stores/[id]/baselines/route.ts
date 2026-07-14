import { getStore, listBaselineMetrics, recalculateFeedProductCountBaseline } from "@eim/db";
import { NextResponse } from "next/server";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const store = await getStore(id);

  if (!store) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  const baselines = await listBaselineMetrics(id);
  return NextResponse.json({ baselines });
}

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const store = await getStore(id);

  if (!store) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  const baseline = await recalculateFeedProductCountBaseline(id);
  return NextResponse.json({ baseline });
}
