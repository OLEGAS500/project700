import { getMerchantCenterOAuthStatus } from "@eim/db";
import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const status = await getMerchantCenterOAuthStatus(id);
    if (!status) {
      return NextResponse.json({ error: "Store not found" }, { status: 404 });
    }

    return NextResponse.json({ status });
  } catch {
    return NextResponse.json(
      { error: "Merchant Center OAuth status is temporarily unavailable" },
      { status: 503 }
    );
  }
}
