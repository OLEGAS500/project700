import { merchantCenterConnectionInputSchema } from "@eim/core";
import {
  connectMerchantCenter,
  disconnectMerchantCenter,
  getMerchantCenterConnection,
  MerchantCenterStoreNotFoundError
} from "@eim/db";
import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const connection = await getMerchantCenterConnection(id);
    if (!connection) {
      return NextResponse.json({ error: "Store not found" }, { status: 404 });
    }

    return NextResponse.json({ connection });
  } catch {
    return unavailableResponse();
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const parsed = merchantCenterConnectionInputSchema.safeParse(
    await request.json().catch(() => null)
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid Merchant Center connection payload" },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json({ connection: await connectMerchantCenter(id, parsed.data) });
  } catch (error) {
    if (error instanceof MerchantCenterStoreNotFoundError) {
      return NextResponse.json({ error: "Store not found" }, { status: 404 });
    }
    return unavailableResponse();
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    return NextResponse.json({ connection: await disconnectMerchantCenter(id) });
  } catch (error) {
    if (error instanceof MerchantCenterStoreNotFoundError) {
      return NextResponse.json({ error: "Store not found" }, { status: 404 });
    }
    return unavailableResponse();
  }
}

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "Merchant Center connection is temporarily unavailable" },
    { status: 503 }
  );
}
