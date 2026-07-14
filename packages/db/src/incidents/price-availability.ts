export type PriceAvailabilityMatchRow = {
  match_method: "offer_id" | "normalized_url" | "canonical_url" | "fallback";
  match_confidence: string;
  matched_key: string;
  feed_url: string | null;
  feed_title: string | null;
  feed_price: string | null;
  feed_currency: string | null;
  feed_availability: string | null;
  storefront_url: string | null;
  storefront_title: string | null;
  storefront_price: string | null;
  storefront_currency: string | null;
  storefront_availability: string | null;
};

export type PriceAvailabilitySignalEvaluation = {
  metric: "price_mismatch_count" | "availability_mismatch_count";
  count: number;
  ratio: number;
  affectedItems: Array<{
    url: string | null;
    title: string | null;
    feedValue: string | null;
    storefrontValue: string | null;
    matchMethod: string;
  }>;
};

export type PriceAvailabilityEvaluationOptions = {
  minimumAffectedCount: number;
  minimumAffectedRatio: number;
  priceTolerance: {
    absolute: number;
    relative: number;
  };
};

export function evaluatePriceAvailabilitySignals(
  rows: PriceAvailabilityMatchRow[],
  options: PriceAvailabilityEvaluationOptions = {
    minimumAffectedCount: 5,
    minimumAffectedRatio: 0.2,
    priceTolerance: { absolute: 0.02, relative: 0.001 }
  }
): PriceAvailabilitySignalEvaluation[] {
  const priceMismatches: PriceAvailabilitySignalEvaluation["affectedItems"] = [];
  const availabilityMismatches: PriceAvailabilitySignalEvaluation["affectedItems"] = [];

  for (const row of rows) {
    const feedPrice = parseComparablePrice(row.feed_price, row.feed_currency);
    const storefrontPrice = parseComparablePrice(
      row.storefront_price,
      row.storefront_currency
    );

    if (
      feedPrice &&
      storefrontPrice &&
      feedPrice.currency === storefrontPrice.currency &&
      isPriceMismatch(feedPrice.amount, storefrontPrice.amount, options.priceTolerance)
    ) {
      priceMismatches.push({
        url: row.storefront_url ?? row.feed_url,
        title: row.storefront_title ?? row.feed_title,
        feedValue: `${feedPrice.amount.toFixed(2)} ${feedPrice.currency}`,
        storefrontValue: `${storefrontPrice.amount.toFixed(2)} ${storefrontPrice.currency}`,
        matchMethod: row.match_method
      });
    }

    const feedAvailability = normalizeAvailability(row.feed_availability);
    const storefrontAvailability = normalizeAvailability(row.storefront_availability);

    if (
      feedAvailability !== "unknown" &&
      storefrontAvailability !== "unknown" &&
      feedAvailability !== storefrontAvailability
    ) {
      availabilityMismatches.push({
        url: row.storefront_url ?? row.feed_url,
        title: row.storefront_title ?? row.feed_title,
        feedValue: feedAvailability,
        storefrontValue: storefrontAvailability,
        matchMethod: row.match_method
      });
    }
  }

  return [
    buildPriceAvailabilitySignal(
      "price_mismatch_count",
      priceMismatches,
      rows.length,
      options.minimumAffectedCount,
      options.minimumAffectedRatio
    ),
    buildPriceAvailabilitySignal(
      "availability_mismatch_count",
      availabilityMismatches,
      rows.length,
      options.minimumAffectedCount,
      options.minimumAffectedRatio
    )
  ].filter((signal): signal is PriceAvailabilitySignalEvaluation => signal !== null);
}

export function priceAvailabilitySignalSummary(
  signal: PriceAvailabilitySignalEvaluation
): string {
  if (signal.metric === "price_mismatch_count") {
    return `${signal.count} products have different effective prices`;
  }

  return `${signal.count} products have different availability`;
}

function buildPriceAvailabilitySignal(
  metric: PriceAvailabilitySignalEvaluation["metric"],
  affectedItems: PriceAvailabilitySignalEvaluation["affectedItems"],
  denominator: number,
  minCount: number,
  minRatio: number
): PriceAvailabilitySignalEvaluation | null {
  const ratio = denominator === 0 ? 0 : affectedItems.length / denominator;

  if (affectedItems.length < minCount || ratio < minRatio) {
    return null;
  }

  return {
    metric,
    count: affectedItems.length,
    ratio,
    affectedItems
  };
}

function parseComparablePrice(
  price: string | null,
  currency: string | null
): { amount: number; currency: string } | null {
  if (!price || !currency) {
    return null;
  }

  const normalizedAmount = Number(price.replace(/[^0-9.,-]/g, "").replace(",", "."));

  if (!Number.isFinite(normalizedAmount)) {
    return null;
  }

  return {
    amount: normalizedAmount,
    currency: currency.toUpperCase()
  };
}

function isPriceMismatch(
  feedPrice: number,
  storefrontPrice: number,
  tolerance: PriceAvailabilityEvaluationOptions["priceTolerance"]
): boolean {
  const diff = Math.abs(feedPrice - storefrontPrice);
  const relative = diff / Math.max(Math.abs(feedPrice), Math.abs(storefrontPrice), 1);

  return diff >= tolerance.absolute && relative >= tolerance.relative;
}

function normalizeAvailability(
  value: string | null
): "in_stock" | "out_of_stock" | "preorder" | "backorder" | "unknown" {
  if (!value) {
    return "unknown";
  }

  const normalized = value
    .toLowerCase()
    .replace(/https?:\/\/schema\.org\//, "")
    .replace(/[\s-]+/g, "_");

  if (["in_stock", "instock", "available"].includes(normalized)) {
    return "in_stock";
  }
  if (["out_of_stock", "outofstock", "sold_out", "unavailable"].includes(normalized)) {
    return "out_of_stock";
  }
  if (normalized.includes("preorder")) {
    return "preorder";
  }
  if (normalized.includes("backorder")) {
    return "backorder";
  }

  return "unknown";
}
