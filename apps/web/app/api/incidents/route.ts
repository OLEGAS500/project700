import { incidentStatusSchema } from "@eim/core";
import { listIncidents } from "@eim/db";
import { NextResponse } from "next/server";
import { z } from "zod";

const storeIdSchema = z.string().uuid();

export async function GET(request: Request) {
  const url = new URL(request.url);
  const storeId = storeIdSchema.safeParse(url.searchParams.get("storeId"));
  const statusValue = url.searchParams.get("status");
  const status = statusValue ? incidentStatusSchema.safeParse(statusValue) : null;

  if (!storeId.success || (statusValue && !status?.success)) {
    return NextResponse.json(
      { error: "storeId must be a UUID and status must be a valid incident status" },
      { status: 400 }
    );
  }

  const incidents = await listIncidents({
    storeId: storeId.data,
    status: status?.data
  });
  return NextResponse.json({ incidents });
}
