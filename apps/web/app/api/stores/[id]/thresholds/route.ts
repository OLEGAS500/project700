import { updateStoreThresholdsInputSchema } from "@eim/core";
import { getStore, getStoreThresholds, updateStoreThresholds } from "@eim/db";
import { NextResponse } from "next/server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const store = await getStore(id);

  if (!store) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  const thresholds = await getStoreThresholds(id);
  return NextResponse.json({ thresholds });
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const store = await getStore(id);

  if (!store) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsed = updateStoreThresholdsInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid threshold payload", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const thresholds = await updateStoreThresholds(id, parsed.data);
  return NextResponse.json({ thresholds });
}
