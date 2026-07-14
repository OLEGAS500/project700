import { createHash } from "node:crypto";
import type { SourceItemInput } from "@eim/core";
import { normalizeUrlForKey } from "@eim/core";
import type { ProductPageObservation } from "./types";

export function productPageObservationToItem(
  observation: ProductPageObservation
): SourceItemInput {
  const normalizedUrl = normalizeUrlForKey(observation.url);
  const normalizedState = {
    finalUrl: observation.finalUrl,
    httpStatus: observation.httpStatus,
    indexability: observation.indexability,
    canonicalUrl: observation.canonicalUrl,
    canonicalState: observation.canonicalState,
    schemaPresent: observation.schemaPresent,
    schemaValidEnough: observation.schemaValidEnough,
    effectivePrice: observation.effectivePrice,
    currency: observation.currency,
    availability: observation.availability,
    imageUrl: observation.imageUrl
  };
  const productPageHash = createHash("sha256")
    .update(JSON.stringify(normalizedState))
    .digest("hex");

  return {
    source: "storefront",
    stableKey: `url:${normalizedUrl}`,
    url: normalizedUrl,
    title: observation.title,
    price: observation.effectivePrice,
    currency: observation.currency,
    availability: observation.availability,
    imageUrl: observation.imageUrl,
    httpStatus: observation.httpStatus,
    indexability: observation.indexability,
    canonicalUrl: observation.canonicalUrl,
    schemaPresent: observation.schemaPresent,
    metadata: {
      checkedAsProductPage: true,
      productPage: observation,
      sourceHashes: {
        productPage: productPageHash
      }
    },
    rawHash: productPageHash
  };
}
