import { describe, expect, it } from "vitest";
import {
  normalizeCrossSourceOfferId,
  normalizeCrossSourceStableKey
} from "./cross-source-product-mapping";

describe("cross-source product identity", () => {
  it("normalizes offer IDs by trimming, collapsing whitespace, and lowercasing", () => {
    expect(normalizeCrossSourceOfferId("  SKU-ABC  ")).toBe("sku-abc");
    expect(normalizeCrossSourceOfferId("  SKU\t  1  ")).toBe("sku 1");
  });

  it("keeps an absent offer distinct from the stable-key fallback", () => {
    expect(normalizeCrossSourceOfferId("   ")).toBeNull();
    expect(normalizeCrossSourceStableKey("  HASH:Unicode-Product  ")).toBe(
      "hash:unicode-product"
    );
  });

  it("keeps Unicode identity values deterministic", () => {
    expect(normalizeCrossSourceOfferId("  Ä-товар😀  ")).toBe("ä-товар😀");
    expect(normalizeCrossSourceStableKey("  Stable:Товар😀  ")).toBe("stable:товар😀");
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
