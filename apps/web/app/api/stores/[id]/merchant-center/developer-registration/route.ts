import { getMerchantCenterConnection } from "@eim/db";
import { registerMerchantCenterDeveloper } from "@eim/worker";
import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const connection = await getMerchantCenterConnection(id);
    const result = await registerMerchantCenterDeveloper({
      storeId: id,
      accountId: connection?.merchantCenterAccountId ?? null
    });

    switch (result.outcome) {
      case "registered":
        return NextResponse.json({ registered: true });
      case "not_connected":
        return NextResponse.json(
          { error: "Merchant Center account is not linked" },
          { status: 409 }
        );
      case "authentication_failed":
        return NextResponse.json(
          { error: "Merchant Center credentials could not authorize developer registration" },
          { status: 401 }
        );
      case "conflict":
        return NextResponse.json(
          { error: "Google Cloud project registration conflicts with an existing Merchant Center registration" },
          { status: 409 }
        );
      case "source_unavailable":
        return NextResponse.json(
          { error: "Merchant Center developer registration is temporarily unavailable" },
          { status: 503 }
        );
    }
  } catch {
    return NextResponse.json(
      { error: "Merchant Center developer registration is temporarily unavailable" },
      { status: 503 }
    );
  }
}
