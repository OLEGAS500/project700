import { describe, expect, it } from "vitest";
import {
  EmailProviderConfigurationError,
  formatEmailFromAddress,
  loadEmailProviderConfiguration,
  redactResendApiKey
} from "./email-configuration";

describe("email provider configuration boundary", () => {
  it("loads Resend credentials only from the environment boundary", () => {
    expect(
      loadEmailProviderConfiguration({
        RESEND_API_KEY: " re_test_secret ",
        EMAIL_FROM_ADDRESS: " alerts@example.com ",
        EMAIL_FROM_NAME: " EIM Alerts "
      })
    ).toEqual({
      apiKey: "re_test_secret",
      fromAddress: "alerts@example.com",
      fromName: "EIM Alerts"
    });
  });

  it.each([
    [{}, "resend_api_key_missing"],
    [{ RESEND_API_KEY: "   " }, "resend_api_key_missing"],
    [{ RESEND_API_KEY: "re_test" }, "email_from_address_missing"],
    [
      { RESEND_API_KEY: "re_test", EMAIL_FROM_ADDRESS: "not-an-address" },
      "email_from_address_invalid"
    ]
  ] as const)("rejects invalid email provider configuration", (environment, code) => {
    expect(() => loadEmailProviderConfiguration(environment)).toThrow(
      EmailProviderConfigurationError
    );
    expect(() => loadEmailProviderConfiguration(environment)).toThrow(code);
  });

  it("formats a display name without parsing a mixed sender string", () => {
    expect(
      formatEmailFromAddress({
        fromAddress: "alerts@example.com",
        fromName: "EIM Alerts"
      })
    ).toBe("EIM Alerts <alerts@example.com>");
    expect(
      formatEmailFromAddress({ fromAddress: "alerts@example.com", fromName: null })
    ).toBe("alerts@example.com");
  });

  it("redacts a Resend key before an error can cross the provider boundary", () => {
    const apiKey = "re_test_secret";
    expect(redactResendApiKey(`Request failed with ${apiKey}`, apiKey)).toBe(
      "Request failed with [REDACTED]"
    );
  });
});
