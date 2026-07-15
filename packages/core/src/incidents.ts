import type { IncidentLikelySource } from "./schemas";

export type FeedCatalogDropInput = {
  currentCount: number;
  baselineMedian: number;
  percentThreshold?: number;
  absoluteThreshold?: number;
};

export type RuleEvaluation = {
  type:
    | "catalog_drop"
    | "source_divergence"
    | "seo_regression"
    | "price_availability_mismatch"
    | "source_health";
  scopeKey: string;
  severity: "critical" | "warning" | "info";
  affectedCount: number;
  signals: Array<{
    source: string;
    metric: string;
    beforeValue?: number;
    afterValue?: number;
    changeAbs?: number;
    changePct?: number;
  }>;
  evidence: string[];
  likelySource?: IncidentLikelySource;
  confidenceScore?: number;
  requiresConfirmation: boolean;
};

export type FeedCatalogDropDecision =
  | {
      isDrop: true;
      changeAbs: number;
      changePct: number;
    }
  | {
      isDrop: false;
      changeAbs: number;
      changePct: number;
  };

export type SourceDivergenceInput = {
  feedCount: number;
  storefrontCount: number;
  percentThreshold?: number;
  absoluteThreshold?: number;
};

export type MatchedStorefrontFeedLossInput = {
  matchedStorefrontCount: number;
  missingFromFeedCount: number;
  percentThreshold?: number;
  absoluteThreshold?: number;
};

export type SourceDivergenceDecision =
  | {
      isDivergent: true;
      changeAbs: number;
      changePct: number;
      direction: "feed_higher" | "storefront_higher";
    }
  | {
      isDivergent: false;
      changeAbs: number;
      changePct: number;
      direction: "feed_higher" | "storefront_higher" | "equal";
    };

export function detectFeedCatalogDrop(
  input: FeedCatalogDropInput
): FeedCatalogDropDecision {
  const percentThreshold = input.percentThreshold ?? 0.2;
  const absoluteThreshold = input.absoluteThreshold ?? 20;
  const changeAbs = input.baselineMedian - input.currentCount;
  const changePct = input.baselineMedian === 0 ? 0 : changeAbs / input.baselineMedian;
  const isDrop =
    input.currentCount <= input.baselineMedian * (1 - percentThreshold) &&
    changeAbs >= absoluteThreshold;

  return {
    isDrop,
    changeAbs,
    changePct
  };
}

export function detectSourceDivergence(
  input: SourceDivergenceInput
): SourceDivergenceDecision {
  const percentThreshold = input.percentThreshold ?? 0.2;
  const absoluteThreshold = input.absoluteThreshold ?? 20;
  const changeAbs = Math.abs(input.feedCount - input.storefrontCount);
  const denominator = Math.max(input.feedCount, input.storefrontCount, 1);
  const changePct = changeAbs / denominator;
  const direction =
    input.feedCount === input.storefrontCount
      ? "equal"
      : input.feedCount > input.storefrontCount
        ? "feed_higher"
        : "storefront_higher";
  const isDivergent = direction !== "equal" && changePct >= percentThreshold && changeAbs >= absoluteThreshold;

  if (isDivergent) {
    return {
      isDivergent: true,
      changeAbs,
      changePct,
      direction
    };
  }

  return {
    isDivergent: false,
    changeAbs,
    changePct,
    direction
  };
}

export function detectMatchedStorefrontFeedLoss(
  input: MatchedStorefrontFeedLossInput
): FeedCatalogDropDecision {
  const percentThreshold = input.percentThreshold ?? 0.1;
  const absoluteThreshold = input.absoluteThreshold ?? 20;
  const changeAbs = input.missingFromFeedCount;
  const changePct =
    input.matchedStorefrontCount === 0 ? 0 : changeAbs / input.matchedStorefrontCount;
  const isDrop =
    input.matchedStorefrontCount > 0 &&
    changePct >= percentThreshold &&
    changeAbs >= absoluteThreshold;

  if (isDrop) {
    return {
      isDrop: true,
      changeAbs,
      changePct
    };
  }

  return {
    isDrop: false,
    changeAbs,
    changePct
  };
}
