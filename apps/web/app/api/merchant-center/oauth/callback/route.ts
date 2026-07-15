import {
  exchangeMerchantCenterAuthorizationCode,
  loadMerchantCenterOAuthConfiguration,
  MerchantCenterOAuthConfigurationError,
  MerchantCenterOAuthProviderError
} from "@eim/core";
import {
  consumeMerchantCenterOAuthState,
  hashMerchantCenterOAuthState,
  MerchantCenterOAuthStateInvalidError,
  upsertMerchantCenterOAuthCredentials
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
  try {
    stateRecord = await consumeMerchantCenterOAuthState(hashMerchantCenterOAuthState(state));
  } catch (error) {
    if (error instanceof MerchantCenterOAuthStateInvalidError) {
      return NextResponse.json({ error: "Invalid or expired Merchant Center OAuth state" }, { status: 400 });
    }
    return unavailableResponse();
  }

  if (providerError || !code || code.length > 4096) {
    return NextResponse.json(
      { error: "Merchant Center authorization was not completed" },
      { status: 400 }
    );
  }

  try {
    const configuration = loadMerchantCenterOAuthConfiguration();
    if (stateRecord.redirectUri !== configuration.redirectUri) {
      return NextResponse.json(
        { error: "Merchant Center OAuth authorization must be restarted" },
        { status: 400 }
      );
    }
    const tokenResponse = await exchangeMerchantCenterAuthorizationCode(configuration, code);
    const refreshToken = tokenResponse.refresh_token;

    if (!refreshToken || !Number.isSafeInteger(tokenResponse.expires_in)) {
      return NextResponse.json(
        { error: "Merchant Center authorization did not return usable offline credentials" },
        { status: 502 }
      );
    }

    const credentials = await upsertMerchantCenterOAuthCredentials(stateRecord.storeId, {
      accessToken: tokenResponse.access_token,
      refreshToken,
      tokenType: tokenResponse.token_type ?? "Bearer",
      expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
      scopes: normalizeScopes(tokenResponse.scope, configuration.scopes),
      metadata: { provider: "google", authorization: "oauth2" }
    });

    return NextResponse.json({ connected: true, storeId: stateRecord.storeId, credentials });
  } catch (error) {
    if (error instanceof MerchantCenterOAuthConfigurationError) {
      return NextResponse.json(
        { error: "Merchant Center OAuth is not configured" },
        { status: 503 }
      );
    }
    if (error instanceof MerchantCenterOAuthProviderError) {
      return NextResponse.json(
        { error: providerErrorMessage(error.code) },
        { status: 502 }
      );
    }
    return unavailableResponse();
  }
}

function normalizeScopes(value: string | undefined, fallback: string[]): string[] {
  const scopes = value?.split(/\s+/).filter(Boolean) ?? fallback;
  return [...new Set(scopes)].slice(0, 32);
}

function providerErrorMessage(code: MerchantCenterOAuthProviderError["code"]): string {
  return code === "oauth_response_invalid"
    ? "Merchant Center returned an invalid OAuth response"
    : "Merchant Center OAuth authorization failed";
}

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "Merchant Center OAuth callback is temporarily unavailable" },
    { status: 503 }
  );
}
