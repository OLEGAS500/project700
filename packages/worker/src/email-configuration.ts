const resendApiKeyEnvironmentVariable = "RESEND_API_KEY";
const emailFromAddressEnvironmentVariable = "EMAIL_FROM_ADDRESS";
const emailFromNameEnvironmentVariable = "EMAIL_FROM_NAME";

export type EmailProviderConfiguration = {
  apiKey: string;
  fromAddress: string;
  fromName: string | null;
};

export type EmailProviderConfigurationErrorCode =
  | "resend_api_key_missing"
  | "email_from_address_missing"
  | "email_from_address_invalid";

export class EmailProviderConfigurationError extends Error {
  constructor(readonly code: EmailProviderConfigurationErrorCode) {
    super(code);
    this.name = "EmailProviderConfigurationError";
  }
}

export function loadEmailProviderConfiguration(
  environment: Record<string, string | undefined> = process.env
): EmailProviderConfiguration {
  const apiKey = environment[resendApiKeyEnvironmentVariable]?.trim();
  if (!apiKey) {
    throw new EmailProviderConfigurationError("resend_api_key_missing");
  }

  const fromAddress = environment[emailFromAddressEnvironmentVariable]?.trim();
  if (!fromAddress) {
    throw new EmailProviderConfigurationError("email_from_address_missing");
  }
  if (!isValidEmailAddress(fromAddress)) {
    throw new EmailProviderConfigurationError("email_from_address_invalid");
  }

  const fromName = normalizeOptionalName(environment[emailFromNameEnvironmentVariable]);
  return { apiKey, fromAddress, fromName };
}

export function formatEmailFromAddress(input: {
  fromAddress: string;
  fromName: string | null;
}): string {
  return input.fromName ? `${input.fromName} <${input.fromAddress}>` : input.fromAddress;
}

export function isValidEmailAddress(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
    !/[\r\n]/.test(value)
  );
}

export function redactResendApiKey(value: string, apiKey: string | undefined): string {
  if (!apiKey) return value.slice(0, 2_000);
  return value.replaceAll(apiKey, "[REDACTED]").slice(0, 2_000);
}

function normalizeOptionalName(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || null;
}
