import {
  buildMerchantCenterAuthorizationUrl,
  loadMerchantCenterOAuthConfiguration,
  MerchantCenterOAuthConfigurationError
} from "@eim/core";
import {
  createMerchantCenterOAuthState,
  hashMerchantCenterOAuthState,
  MerchantCenterStoreNotFoundError
} from "@eim/db";
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

const oauthStateLifetimeMs = 10 * 60 * 1000;
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const configuration = loadMerchantCenterOAuthConfiguration();
    const state = randomBytes(32).toString("base64url");
    await createMerchantCenterOAuthState(id, {
      stateHash: hashMerchantCenterOAuthState(state),
      redirectUri: configuration.redirectUri,
      expiresAt: new Date(Date.now() + oauthStateLifetimeMs)
    });

    return NextResponse.redirect(buildMerchantCenterAuthorizationUrl(configuration, state), {
      status: 302
    });
  } catch (error) {
    if (error instanceof MerchantCenterStoreNotFoundError) {
      return NextResponse.json({ error: "Store not found" }, { status: 404 });
    }
    if (error instanceof MerchantCenterOAuthConfigurationError) {
      return NextResponse.json(
        { error: "Merchant Center OAuth is not configured" },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Merchant Center authorization is temporarily unavailable" },
      { status: 503 }
    );
  }
}
