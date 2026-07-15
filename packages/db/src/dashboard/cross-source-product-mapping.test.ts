import { describe, expect, it } from "vitest";
import { normalizeCrossSourceIdentity } from "./cross-source-product-mapping";

describe("cross-source product identity", () => {
  it("normalizes offer IDs by trimming and lowercasing", () => {
    expect(
      normalizeCrossSourceIdentity({
        offerId: "  SKU-ABC  ",
        stableKey: "offer:ignored"
      })
    ).toBe("offer:sku-abc");
  });

  it("uses the existing stable key only when offer ID is unavailable", () => {
    expect(
      normalizeCrossSourceIdentity({
        offerId: "   ",
        stableKey: "  HASH:Unicode-Product  "
      })
    ).toBe("stable:hash:unicode-product");
  });

  it("keeps Unicode identity values deterministic", () => {
    expect(
      normalizeCrossSourceIdentity({
        offerId: "  Ä-товар😀  ",
        stableKey: "offer:unused"
      })
    ).toBe("offer:ä-товар😀");
  });

  it("does not send malformed snapshot identifiers to PostgreSQL", async () => {
    const { getCrossSourceProductMatchSummary } = await import("./cross-source-product-mapping");

    await expect(
      getCrossSourceProductMatchSummary({
        feedSnapshotId: "not-a-uuid",
        merchantSnapshotId: "also-not-a-uuid"
      })
    ).resolves.toBeNull();
  });
});
