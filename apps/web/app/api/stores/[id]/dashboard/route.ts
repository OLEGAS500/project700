import { getDashboardStoreSummary } from "@eim/db";
import { NextResponse } from "next/server";
import { z } from "zod";

const storeIdSchema = z.string().uuid();

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const storeId = storeIdSchema.safeParse(id);

  if (!storeId.success) {
    return NextResponse.json({ error: "Store id must be a UUID" }, { status: 400 });
  }

  const store = await getDashboardStoreSummary(storeId.data);
  if (!store) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  return NextResponse.json({ store });
}
