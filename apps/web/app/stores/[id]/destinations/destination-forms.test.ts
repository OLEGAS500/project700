import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  upsertEmailDestinationAction: vi.fn(),
  upsertTelegramDestinationAction: vi.fn()
}));

import { EmailDestinationForm, TelegramDestinationForm } from "./destination-forms";

describe("destination forms", () => {
  it("renders email recipients and enabled state", () => {
    const html = renderToStaticMarkup(
      createElement(EmailDestinationForm, {
        storeId: "70000000-0000-4000-8000-000000000001",
        destination: {
          id: "email-1",
          storeId: "store-1",
          recipientEmails: ["alerts@example.com", "ops@example.com"],
          enabled: true,
          disabledAt: null,
          createdAt: "2026-07-15T10:00:00.000Z",
          updatedAt: "2026-07-15T10:00:00.000Z"
        }
      })
    );

    expect(html).toContain("alerts@example.com");
    expect(html).toContain("ops@example.com");
    expect(html).toContain('name="emailEnabled" checked=""');
    expect(html).toContain("Save email destination");
  });

  it("renders Telegram settings without provider diagnostics", () => {
    const html = renderToStaticMarkup(
      createElement(TelegramDestinationForm, {
        storeId: "70000000-0000-4000-8000-000000000001",
        destination: {
          id: "telegram-1",
          storeId: "store-1",
          chatId: "-1001234567890",
          threadId: 42,
          displayName: "SEO alerts",
          enabled: false,
          verifiedAt: null,
          lastVerificationError: "Provider secret diagnostics must not render",
          disabledAt: "2026-07-15T10:00:00.000Z",
          createdAt: "2026-07-15T10:00:00.000Z",
          updatedAt: "2026-07-15T10:00:00.000Z"
        }
      })
    );

    expect(html).toContain('name="chatId"');
    expect(html).toContain('value="-1001234567890"');
    expect(html).toContain('name="threadId"');
    expect(html).toContain('value="42"');
    expect(html).toContain("SEO alerts");
    expect(html).not.toContain("Provider secret diagnostics");
  });
});
