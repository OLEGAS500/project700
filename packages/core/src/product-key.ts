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

export function normalizeOfferId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized ? normalized.toLowerCase() : undefined;
}

export function createStableProductKey(input: ProductKeyInput): string {
  const offerId = normalizeOfferId(input.offerId);
  if (offerId) {
    return `offer:${offerId}`;
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
