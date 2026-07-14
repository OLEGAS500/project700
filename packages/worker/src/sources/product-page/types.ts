export type ProductPageExtractionStrategy =
  | "shopify_json"
  | "json_ld"
  | "embedded_json"
  | "html";

export type CanonicalState = "self" | "different" | "missing" | "invalid";

export type ProductPageObservation = {
  url: string;
  finalUrl?: string;
  httpStatus?: number;
  redirectCount: number;
  redirectChain: string[];
  crossDomainRedirect: boolean;
  indexability: "indexable" | "noindex" | "blocked_by_robots" | "unknown";
  canonicalUrl?: string;
  canonicalState: CanonicalState;
  schemaPresent: boolean;
  schemaValidEnough: boolean;
  title?: string;
  imageUrl?: string;
  imageReachable?: boolean;
  basePrice?: string;
  salePrice?: string;
  effectivePrice?: string;
  currency?: string;
  availability?: string;
  extractionStrategy: ProductPageExtractionStrategy;
};
