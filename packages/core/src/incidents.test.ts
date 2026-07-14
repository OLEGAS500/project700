import { describe, expect, it } from "vitest";
import {
  detectFeedCatalogDrop,
  detectMatchedStorefrontFeedLoss,
  detectSourceDivergence
} from "./incidents";

describe("detectFeedCatalogDrop", () => {
  it("does not trigger for small drops", () => {
    expect(
      detectFeedCatalogDrop({
        baselineMedian: 1000,
        currentCount: 950
      }).isDrop
    ).toBe(false);
  });

  it("requires both percentage and absolute thresholds", () => {
    expect(
      detectFeedCatalogDrop({
        baselineMedian: 1000,
        currentCount: 790
      })
    ).toMatchObject({
      isDrop: true,
      changeAbs: 210,
      changePct: 0.21
    });
    expect(
      detectFeedCatalogDrop({
        baselineMedian: 50,
        currentCount: 39
      }).isDrop
    ).toBe(false);
  });
});

describe("detectSourceDivergence", () => {
  it("detects significant feed and storefront count divergence", () => {
    expect(
      detectSourceDivergence({
        feedCount: 500,
        storefrontCount: 360
      })
    ).toMatchObject({
      isDivergent: true,
      changeAbs: 140,
      changePct: 0.28,
      direction: "feed_higher"
    });
  });

  it("requires both percentage and absolute thresholds", () => {
    expect(
      detectSourceDivergence({
        feedCount: 500,
        storefrontCount: 470
      }).isDivergent
    ).toBe(false);
    expect(
      detectSourceDivergence({
        feedCount: 50,
        storefrontCount: 39
      }).isDivergent
    ).toBe(false);
  });
});

describe("detectMatchedStorefrontFeedLoss", () => {
  it("detects storefront products missing from the feed", () => {
    expect(
      detectMatchedStorefrontFeedLoss({
        matchedStorefrontCount: 360,
        missingFromFeedCount: 82
      })
    ).toMatchObject({
      isDrop: true,
      changeAbs: 82
    });
  });

  it("requires both percentage and absolute thresholds", () => {
    expect(
      detectMatchedStorefrontFeedLoss({
        matchedStorefrontCount: 360,
        missingFromFeedCount: 18
      }).isDrop
    ).toBe(false);
    expect(
      detectMatchedStorefrontFeedLoss({
        matchedStorefrontCount: 1000,
        missingFromFeedCount: 50
      }).isDrop
    ).toBe(false);
  });
});
