import { listDashboardStoreSummaries } from "@eim/db";
import { NextResponse } from "next/server";

export async function GET() {
  const stores = await listDashboardStoreSummaries();
  return NextResponse.json({ stores });
}
