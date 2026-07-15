import { describe, expect, it } from "vitest";
import { incidentContext, safeExternalUrl, statusTransitionLabel } from "./incident-detail-view";

describe("incident detail view helpers", () => {
  it("does not frame source-health incidents as product-loss conclusions", () => {
    expect(incidentContext("source_health")).toBe(
      "This reports source verification health, such as an unavailable, partial, or blocked source. No conclusion has been made about product availability."
    );
    expect(incidentContext("catalog_drop")).toBeNull();
  });

  it("only accepts http and https sample links", () => {
    expect(safeExternalUrl("https://shop.example.com/products/a")).toBe(
      "https://shop.example.com/products/a"
    );
    expect(safeExternalUrl("http://shop.example.com/products/a")).toBe(
      "http://shop.example.com/products/a"
    );
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("ftp://shop.example.com/file")).toBeNull();
    expect(safeExternalUrl("not-a-url")).toBeNull();
  });

  it("renders only explicit lifecycle transitions", () => {
    expect(statusTransitionLabel("open", "recovering")).toBe("Open to Recovering");
    expect(statusTransitionLabel(null, "open")).toBe("Changed to Open");
    expect(statusTransitionLabel(null, null)).toBe("No lifecycle status change");
  });
});
