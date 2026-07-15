import {
  exchangeMerchantCenterAuthorizationCode,
  loadMerchantCenterOAuthConfiguration,
  MerchantCenterOAuthConfigurationError,
  MerchantCenterOAuthProviderError
} from "@eim/core";
import {
  consumeMerchantCenterOAuthState,
  completeMerchantCenterOAuthAuthorization,
  hashMerchantCenterOAuthState,
  MerchantCenterOAuthStateInvalidError,
} from "@eim/db";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state")?.trim();
  const code = url.searchParams.get("code")?.trim();
  const providerError = url.searchParams.get("error")?.trim();

  if (!state || state.length > 256) {
    return NextResponse.json({ error: "Invalid Merchant Center OAuth callback" }, { status: 400 });
  }

  let stateRecord;
  const stateHash = hashMerchantCenterOAuthState(state);
  try {
    stateRecord = await consumeMerchantCenterOAuthState(stateHash);
  } catch (error) {
    if (error instanceof MerchantCenterOAuthStateInvalidError) {
      return NextResponse.json({ error: "Invalid or expired Merchant Center OAuth state" }, { status: 400 });
    }
    return unavailableResponse();
  }

  if (providerError || !code || code.length > 4096) {
    if (providerError) {
      return redirectToMerchantCenter(request, stateRecord.storeId, "cancelled");
    }
    return redirectToMerchantCenter(request, stateRecord.storeId, "error");
  }

  try {
    const configuration = loadMerchantCenterOAuthConfiguration();
    if (stateRecord.redirectUri !== configuration.redirectUri) {
      return redirectToMerchantCenter(request, stateRecord.storeId, "error");
    }
    const tokenResponse = await exchangeMerchantCenterAuthorizationCode(configuration, code);
    const refreshToken = tokenResponse.refresh_token;

    if (!refreshToken || !Number.isSafeInteger(tokenResponse.expires_in)) {
      return redirectToMerchantCenter(request, stateRecord.storeId, "error");
    }

    await completeMerchantCenterOAuthAuthorization(stateHash, {
      accessToken: tokenResponse.access_token,
      refreshToken,
      tokenType: tokenResponse.token_type ?? "Bearer",
      expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
      scopes: normalizeScopes(tokenResponse.scope, configuration.scopes),
      metadata: { provider: "google", authorization: "oauth2" }
    });

    return redirectToMerchantCenter(request, stateRecord.storeId, "connected");
  } catch (error) {
    if (error instanceof MerchantCenterOAuthConfigurationError) {
      return redirectToMerchantCenter(request, stateRecord.storeId, "configuration_unavailable");
    }
    if (error instanceof MerchantCenterOAuthProviderError) {
      return redirectToMerchantCenter(request, stateRecord.storeId, "error");
    }
    if (error instanceof MerchantCenterOAuthStateInvalidError) {
      return redirectToMerchantCenter(request, stateRecord.storeId, "reconnect_required");
    }
    return redirectToMerchantCenter(request, stateRecord.storeId, "error");
  }
}

function normalizeScopes(value: string | undefined, fallback: string[]): string[] {
  const scopes = value?.split(/\s+/).filter(Boolean) ?? fallback;
  return [...new Set(scopes)].slice(0, 32);
}

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "Merchant Center OAuth callback is temporarily unavailable" },
    { status: 503 }
  );
}

function redirectToMerchantCenter(
  request: Request,
  storeId: string,
  outcome: "connected" | "cancelled" | "error" | "configuration_unavailable" | "reconnect_required"
): NextResponse {
  const target = new URL(
    `/stores/${encodeURIComponent(storeId)}/merchant-center?oauth=${outcome}`,
    request.url
  );
  return NextResponse.redirect(target, { status: 303 });
}
