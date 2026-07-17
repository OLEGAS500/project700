import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({
  disconnectMerchantCenterAction: vi.fn()
}));

import MerchantCenterControls from "./merchant-center-controls";

const storeId = "70000000-0000-4000-8000-000000000001";

describe("Merchant Center controls", () => {
  it("shows safe refresh and disconnect controls for credentials", () => {
    const html = renderToStaticMarkup(
      createElement(MerchantCenterControls, {
        storeId,
        configurationAvailable: true,
        connection: { storeId, merchantCenterAccountId: "123456789", connected: true },
        status: {
          storeId,
          credentials: {
            storeId,
            hasAccessToken: true,
            hasRefreshToken: true,
            tokenType: "Bearer",
            expiresAt: "2099-01-01T00:00:00.000Z",
            scopes: ["content"],
            metadata: { provider: "google" },
            credentialsVersion: 3,
            refreshInProgress: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z"
          }
        }
      })
    );

    expect(html).toContain("Refresh credentials");
    expect(html).toContain(">Refresh credentials</button>");
    expect(html).toContain("Activate Merchant API");
    expect(html).toContain("Registers the configured Google Cloud project");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("access-secret");
    expect(html).not.toContain("refresh-secret");
    expect(html).not.toContain("provider URL");
  });

  it("does not offer refresh or disconnect when not connected", () => {
    const html = renderToStaticMarkup(
      createElement(MerchantCenterControls, {
        storeId,
        configurationAvailable: true,
        connection: { storeId, merchantCenterAccountId: null, connected: false },
        status: { storeId, credentials: null }
      })
    );

    expect(html).toContain("Connect Merchant Center");
    expect(html).not.toContain("Refresh credentials");
    expect(html).not.toContain("Activate Merchant API");
    expect(html).not.toContain("Disconnect");
  });
});
