import {
  loadMerchantCenterOAuthConfiguration,
  MerchantCenterOAuthConfigurationError,
  MerchantCenterOAuthProviderError,
  refreshMerchantCenterAccessToken
} from "@eim/core";
import {
  claimMerchantCenterOAuthRefresh,
  completeMerchantCenterOAuthRefresh,
  MerchantCenterOAuthCredentialLeaseLostError,
  MerchantCenterOAuthCredentialsNotFoundError,
  MerchantCenterOAuthRefreshInProgressError,
  releaseMerchantCenterOAuthRefresh
} from "@eim/db";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const lockId = randomUUID();
  let claimed = false;

  try {
    const configuration = loadMerchantCenterOAuthConfiguration();
    const current = await claimMerchantCenterOAuthRefresh(id, lockId);
    claimed = true;
    const tokenResponse = await refreshMerchantCenterAccessToken(configuration, current.refreshToken);
    const credentials = await completeMerchantCenterOAuthRefresh(id, lockId, {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? current.refreshToken,
      tokenType: tokenResponse.token_type ?? current.tokenType,
      expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
      scopes: normalizeScopes(tokenResponse.scope, current.scopes),
      metadata: current.metadata
    });

    return NextResponse.json({ refreshed: true, credentials });
  } catch (error) {
    if (error instanceof MerchantCenterOAuthConfigurationError) {
      return NextResponse.json(
        { error: "Merchant Center OAuth is not configured" },
        { status: 503 }
      );
    }
    if (error instanceof MerchantCenterOAuthCredentialsNotFoundError) {
      return NextResponse.json({ error: "Merchant Center OAuth credentials not found" }, { status: 404 });
    }
    if (error instanceof MerchantCenterOAuthRefreshInProgressError) {
      return NextResponse.json(
        { error: "Merchant Center OAuth refresh is already in progress" },
        { status: 409 }
      );
    }
    if (error instanceof MerchantCenterOAuthCredentialLeaseLostError) {
      return NextResponse.json(
        { error: "Merchant Center OAuth refresh could not be completed" },
        { status: 409 }
      );
    }
    if (error instanceof MerchantCenterOAuthProviderError) {
      return NextResponse.json(
        { error: "Merchant Center OAuth refresh failed" },
        { status: 502 }
      );
    }
    return NextResponse.json(
      { error: "Merchant Center OAuth refresh is temporarily unavailable" },
      { status: 503 }
    );
  } finally {
    if (claimed) {
      await releaseMerchantCenterOAuthRefresh(id, lockId).catch(() => undefined);
    }
  }
}

function normalizeScopes(value: string | undefined, fallback: string[]): string[] {
  const scopes = value?.split(/\s+/).filter(Boolean) ?? fallback;
  return [...new Set(scopes)].slice(0, 32);
}
