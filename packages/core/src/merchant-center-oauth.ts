import {
  merchantCenterOAuthTokenResponseSchema,
  type MerchantCenterOAuthTokenResponse
} from "./schemas";

export const merchantCenterOAuthScope = "https://www.googleapis.com/auth/content";

export type MerchantCenterOAuthConfiguration = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
};

export class MerchantCenterOAuthConfigurationError extends Error {
  constructor(readonly code: "oauth_configuration_missing" | "oauth_configuration_invalid") {
    super(code);
    this.name = "MerchantCenterOAuthConfigurationError";
  }
}

export class MerchantCenterOAuthProviderError extends Error {
  constructor(
    readonly code: "oauth_exchange_failed" | "oauth_refresh_failed" | "oauth_response_invalid"
  ) {
    super(code);
    this.name = "MerchantCenterOAuthProviderError";
  }
}

export function loadMerchantCenterOAuthConfiguration(
  environment: Record<string, string | undefined> = process.env
): MerchantCenterOAuthConfiguration {
  const clientId = environment.GOOGLE_MERCHANT_CENTER_CLIENT_ID?.trim();
  const clientSecret = environment.GOOGLE_MERCHANT_CENTER_CLIENT_SECRET?.trim();
  const redirectUri = environment.GOOGLE_MERCHANT_CENTER_REDIRECT_URI?.trim();

  if (!clientId || !clientSecret || !redirectUri) {
    throw new MerchantCenterOAuthConfigurationError("oauth_configuration_missing");
  }

  try {
    const parsedRedirectUri = new URL(redirectUri);
    if (parsedRedirectUri.protocol !== "http:" && parsedRedirectUri.protocol !== "https:") {
      throw new Error("unsupported redirect URI protocol");
    }
  } catch {
    throw new MerchantCenterOAuthConfigurationError("oauth_configuration_invalid");
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: [merchantCenterOAuthScope]
  };
}

export function buildMerchantCenterAuthorizationUrl(
  configuration: MerchantCenterOAuthConfiguration,
  state: string
): string {
  const url = new URL(configuration.authorizationEndpoint);
  url.searchParams.set("client_id", configuration.clientId);
  url.searchParams.set("redirect_uri", configuration.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", configuration.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export type MerchantCenterOAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export async function exchangeMerchantCenterAuthorizationCode(
  configuration: MerchantCenterOAuthConfiguration,
  code: string,
  fetchImpl: MerchantCenterOAuthFetch = fetch
): Promise<MerchantCenterOAuthTokenResponse> {
  return requestMerchantCenterOAuthToken(
    configuration,
    new URLSearchParams({
      code,
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      redirect_uri: configuration.redirectUri,
      grant_type: "authorization_code"
    }),
    "oauth_exchange_failed",
    fetchImpl
  );
}

export async function refreshMerchantCenterAccessToken(
  configuration: MerchantCenterOAuthConfiguration,
  refreshToken: string,
  fetchImpl: MerchantCenterOAuthFetch = fetch
): Promise<MerchantCenterOAuthTokenResponse> {
  return requestMerchantCenterOAuthToken(
    configuration,
    new URLSearchParams({
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }),
    "oauth_refresh_failed",
    fetchImpl
  );
}

async function requestMerchantCenterOAuthToken(
  configuration: MerchantCenterOAuthConfiguration,
  body: URLSearchParams,
  failureCode: "oauth_exchange_failed" | "oauth_refresh_failed",
  fetchImpl: MerchantCenterOAuthFetch
): Promise<MerchantCenterOAuthTokenResponse> {
  let response: Response;

  try {
    response = await fetchImpl(configuration.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
  } catch {
    throw new MerchantCenterOAuthProviderError(failureCode);
  }

  if (!response.ok) {
    throw new MerchantCenterOAuthProviderError(failureCode);
  }

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(await response.text());
  } catch {
    throw new MerchantCenterOAuthProviderError("oauth_response_invalid");
  }

  const parsed = merchantCenterOAuthTokenResponseSchema.safeParse(bodyJson);
  if (!parsed.success) {
    throw new MerchantCenterOAuthProviderError("oauth_response_invalid");
  }

  return parsed.data;
}
