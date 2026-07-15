import { describe, expect, it } from "vitest";
import {
  decodeDashboardMerchantRemediationCursor,
  encodeDashboardMerchantRemediationCursor,
  InvalidDashboardMerchantRemediationCursorError
} from "./merchant-remediation-queue";

describe("Merchant remediation queue cursors", () => {
  it("round-trips the sort and keyset fields", () => {
    const cursor = {
      version: 2 as const,
      sort: "priority" as const,
      priorityRank: 3,
      issueCount: 4,
      stableKey: "offer:sku-1",
      titleKey: "Product one",
      sourceItemId: "70000000-0000-4000-8000-000000000001",
      filterFingerprint: "a".repeat(64)
    };

    expect(decodeDashboardMerchantRemediationCursor(encodeDashboardMerchantRemediationCursor(cursor))).toEqual(
      cursor
    );
  });

  it("rejects malformed or unsafe cursor payloads", () => {
    const validPayload = {
      version: 2,
      sort: "priority",
      priorityRank: 3,
      issueCount: 4,
      stableKey: "offer:sku-1",
      titleKey: "Product one",
      sourceItemId: "70000000-0000-4000-8000-000000000001",
      filterFingerprint: "a".repeat(64)
    };
    const encodePayload = (overrides: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ ...validPayload, ...overrides })).toString("base64url");

    for (const issueCount of [-1, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      expect(() => decodeDashboardMerchantRemediationCursor(encodePayload({ issueCount }))).toThrow(
        InvalidDashboardMerchantRemediationCursorError
      );
    }
    expect(() => decodeDashboardMerchantRemediationCursor(encodePayload({ priorityRank: 9 }))).toThrow(
      InvalidDashboardMerchantRemediationCursorError
    );
    expect(() => decodeDashboardMerchantRemediationCursor("not-a-cursor")).toThrow(
      InvalidDashboardMerchantRemediationCursorError
    );
  });

  it("accepts PostgreSQL character-bounded emoji sort keys", () => {
    const cursor = {
      version: 2 as const,
      sort: "priority" as const,
      priorityRank: 3,
      issueCount: 1,
      stableKey: "offer:emoji",
      titleKey: "😀".repeat(129),
      sourceItemId: "70000000-0000-4000-8000-000000000001",
      filterFingerprint: "b".repeat(64)
    };

    expect(decodeDashboardMerchantRemediationCursor(encodeDashboardMerchantRemediationCursor(cursor))).toEqual(
      cursor
    );
  });
});
