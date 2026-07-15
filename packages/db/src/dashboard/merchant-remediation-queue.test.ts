import { describe, expect, it } from "vitest";
import {
  decodeDashboardMerchantRemediationCursor,
  encodeDashboardMerchantRemediationCursor,
  InvalidDashboardMerchantRemediationCursorError
} from "./merchant-remediation-queue";

describe("Merchant remediation queue cursors", () => {
  it("round-trips the sort and keyset fields", () => {
    const cursor = {
      version: 1 as const,
      sort: "priority" as const,
      priorityRank: 3,
      issueCount: 4,
      stableKey: "offer:sku-1",
      titleKey: "Product one",
      sourceItemId: "70000000-0000-4000-8000-000000000001"
    };

    expect(decodeDashboardMerchantRemediationCursor(encodeDashboardMerchantRemediationCursor(cursor))).toEqual(
      cursor
    );
  });

  it("rejects malformed or unsafe cursor payloads", () => {
    const invalid = Buffer.from(
      JSON.stringify({
        version: 1,
        sort: "priority",
        priorityRank: 9,
        issueCount: -1,
        stableKey: "offer:sku-1",
        titleKey: "Product one",
        sourceItemId: "70000000-0000-4000-8000-000000000001"
      })
    ).toString("base64url");

    expect(() => decodeDashboardMerchantRemediationCursor(invalid)).toThrow(
      InvalidDashboardMerchantRemediationCursorError
    );
    expect(() => decodeDashboardMerchantRemediationCursor("not-a-cursor")).toThrow(
      InvalidDashboardMerchantRemediationCursorError
    );
  });
});
