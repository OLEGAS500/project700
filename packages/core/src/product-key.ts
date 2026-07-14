import { createHash } from "node:crypto";
import { normalizeUrlForKey } from "./normalize";

type ProductKeyInput = {
  offerId?: string | null;
  url?: string | null;
  canonicalUrl?: string | null;
  title?: string | null;
  imageUrl?: string | null;
  price?: string | null;
};

export function createStableProductKey(input: ProductKeyInput): string {
  if (input.offerId?.trim()) {
    return `offer:${input.offerId.trim().toLowerCase()}`;
  }

  if (input.url?.trim()) {
    return `url:${normalizeUrlForKey(input.url.trim())}`;
  }

  if (input.canonicalUrl?.trim()) {
    return `canonical:${normalizeUrlForKey(input.canonicalUrl.trim())}`;
  }

  const fallback = [input.title, input.imageUrl, input.price]
    .map((value) => value?.trim().toLowerCase() ?? "")
    .join("|");

  return `hash:${createHash("sha256").update(fallback).digest("hex")}`;
}
