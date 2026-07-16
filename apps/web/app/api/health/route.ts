import { getPool } from "@eim/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStoreHeaders = {
  "Cache-Control": "no-store"
};

export async function GET() {
  try {
    await getPool().query("SELECT 1");
    return NextResponse.json({ status: "ok" }, { headers: noStoreHeaders });
  } catch {
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers: noStoreHeaders }
    );
  }
}
