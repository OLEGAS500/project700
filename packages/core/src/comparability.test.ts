import { describe, expect, it } from "vitest";
import { canCompareField } from "./comparability";

describe("canCompareField", () => {
  it("allows fields observed successfully in both snapshots", () => {
    expect(
      canCompareField(
        "canonicalUrl",
        { sourceCheckStatus: "success", value: "https://example.com/a" },
        { sourceCheckStatus: "partial", value: "https://example.com/b" }
      )
    ).toBe(true);
  });

  it("does not compare timeout or parser failures as regressions", () => {
    expect(
      canCompareField(
        "indexability",
        { sourceCheckStatus: "success", value: "indexable" },
        { sourceCheckStatus: "timeout", value: undefined }
      )
    ).toBe(false);
    expect(
      canCompareField(
        "price",
        { sourceCheckStatus: "parse_failed", value: undefined },
        { sourceCheckStatus: "success", value: "10.00" }
      )
    ).toBe(false);
  });

  it("requires field extraction to have succeeded", () => {
    expect(
      canCompareField(
        "price",
        { sourceCheckStatus: "success", value: "10.00" },
        { sourceCheckStatus: "success", value: undefined, extractionSucceeded: false }
      )
    ).toBe(false);
  });
});
