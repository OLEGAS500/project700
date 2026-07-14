import { describe, expect, it } from "vitest";
import { canonicalAlertPayloadSchema, type CanonicalAlertPayload } from "./payload";
import { renderTelegramAlert } from "./telegram";

describe("canonical alert payload", () => {
  it("validates the versioned v1 contract and limits product samples", () => {
    expect(canonicalAlertPayloadSchema.parse(makePayload()).version).toBe("v1");
    expect(
      canonicalAlertPayloadSchema.safeParse({
        ...makePayload(),
        samples: Array.from({ length: 11 }, (_, index) => ({ stableKey: `sku-${index}` }))
      }).success
    ).toBe(false);
  });
});

describe("renderTelegramAlert", () => {
  it("renders distinct opened, worsened, and resolved messages", () => {
    const opened = renderTelegramAlert(makePayload()).text;
    const worsened = renderTelegramAlert(
      makePayload({ alertType: "incident_worsened" })
    ).text;
    const resolved = renderTelegramAlert(
      makePayload({ alertType: "incident_resolved" })
    ).text;

    expect(opened).toContain("Catalog drop detected");
    expect(worsened).toContain("Incident worsened");
    expect(resolved).toContain("Incident resolved");
    expect(new Set([opened, worsened, resolved]).size).toBe(3);
  });

  it("states that source-health failures do not confirm missing products", () => {
    const rendered = renderTelegramAlert(
      makePayload({
        incident: {
          ...makePayload().incident,
          type: "source_health",
          title: "Feed source could not be verified",
          summary: "The feed XML could not be parsed.",
          likelySource: "feed"
        },
        metrics: [
          {
            name: "source_check_failure_count",
            beforeValue: "642",
            afterValue: "2",
            unit: "checks"
          }
        ],
        evidence: ["feed source check returned parse_failed"],
        event: { ...makePayload().event, reason: null }
      })
    );

    expect(rendered.text).toContain("Feed monitoring failure");
    expect(rendered.text).toContain("Products are not confirmed missing.");
    expect(rendered.text).toContain("Consecutive failures");
    expect(rendered.text).toContain("parse_failed");
  });

  it("handles missing metrics and escapes untrusted Telegram HTML", () => {
    const rendered = renderTelegramAlert(
      makePayload({
        store: {
          ...makePayload().store,
          name: "Store <script>alert('x')</script> & Co"
        },
        metrics: [],
        evidence: ["Price < 10 & title > expected"]
      })
    );

    expect(rendered.parseMode).toBe("HTML");
    expect(rendered.text).not.toContain("<script>");
    expect(rendered.text).toContain("&lt;script&gt;");
    expect(rendered.text).toContain("&amp; Co");
  });

  it("truncates long messages only at complete line boundaries", () => {
    const rendered = renderTelegramAlert(
      makePayload({
        metrics: Array.from({ length: 8 }, (_, index) => ({
          name: `metric_${index}_${"x".repeat(2_000)}`,
          beforeValue: "1",
          afterValue: "2",
          unit: null
        }))
      })
    );

    expect(rendered.text.length).toBeLessThanOrEqual(3_900);
    expect(rendered.text).toMatch(/\.\.\.$/);
    expect(rendered.text).not.toMatch(/&(?:a|am|amp|l|lt|g|gt|q|qu|quo|quot)$/);
  });
});

function makePayload(
  overrides: Partial<CanonicalAlertPayload> = {}
): CanonicalAlertPayload {
  return {
    version: "v1",
    alertType: "incident_opened",
    store: {
      id: "223b533f-cb3b-455f-968d-961dd2b4779d",
      name: "Example Store",
      domain: "https://example.com"
    },
    incident: {
      id: "5160658d-fb51-47c5-8766-043f627a52ac",
      type: "catalog_drop",
      severity: "critical",
      title: "Catalog drop detected",
      summary: "The product feed count fell below the active baseline guardrails.",
      status: "open",
      affectedCount: 210,
      likelySource: "feed",
      confidenceScore: 0.86,
      firstDetectedAt: "2026-07-14T10:00:00.000Z"
    },
    metrics: [
      {
        name: "product_count",
        beforeValue: "1000",
        afterValue: "790",
        unit: "products"
      }
    ],
    evidence: ["Sitemap count remained stable while the feed count dropped."],
    samples: [
      {
        stableKey: "offer-1",
        offerId: "offer-1",
        url: "https://example.com/products/one",
        title: "Product One"
      }
    ],
    event: {
      id: "79a672c4-2438-490f-b810-ee0e1add13f0",
      type: "incident_opened",
      reason: "confirmation_matched_drop",
      occurredAt: "2026-07-14T10:05:00.000Z"
    },
    ...overrides
  };
}
