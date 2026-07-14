import { describe, expect, it } from "vitest";
import { createStableProductKey } from "./product-key";

describe("createStableProductKey", () => {
  it("prefers offer IDs", () => {
    expect(
      createStableProductKey({
        offerId: " SKU-123 ",
        url: "https://example.com/products/shoe?variant=1"
      })
    ).toBe("offer:sku-123");
  });

  it("normalizes product URLs", () => {
    expect(
      createStableProductKey({
        url: "https://EXAMPLE.com/products/shoe/?variant=1&utm_source=test#details"
      })
    ).toBe("url:https://example.com/products/shoe");
  });

  it("falls back to a deterministic hash", () => {
    const first = createStableProductKey({
      title: "Trail Shoe",
      imageUrl: "https://example.com/shoe.jpg",
      price: "79.00"
    });
    const second = createStableProductKey({
      title: "Trail Shoe",
      imageUrl: "https://example.com/shoe.jpg",
      price: "79.00"
    });

    expect(first).toBe(second);
    expect(first.startsWith("hash:")).toBe(true);
  });
});
