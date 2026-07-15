import type { DashboardIncidentDetail } from "@eim/db";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  getDashboardIncidentDetail: vi.fn()
}));

const navigation = vi.hoisted(() => ({
  notFound: vi.fn()
}));

vi.mock("@eim/db", () => database);
vi.mock("next/navigation", () => navigation);

import IncidentDetailPage from "./page";

const incidentId = "70000000-0000-4000-8000-000000000001";

describe("incident detail page", () => {
  beforeEach(() => {
    database.getDashboardIncidentDetail.mockReset();
    navigation.notFound.mockReset();
  });

  it("rejects an invalid id without reading the database", async () => {
    const html = await renderPage("not-a-uuid");

    expect(database.getDashboardIncidentDetail).not.toHaveBeenCalled();
    expect(html).toContain("Invalid incident link");
  });

  it("signals a real Next.js not-found transition for an unknown incident", async () => {
    database.getDashboardIncidentDetail.mockResolvedValue(null);
    navigation.notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await expect(renderPage(incidentId)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(database.getDashboardIncidentDetail).toHaveBeenCalledWith(incidentId);
    expect(navigation.notFound).toHaveBeenCalledOnce();
  });

  it("renders safe source-health detail without leaking evidence metadata", async () => {
    database.getDashboardIncidentDetail.mockResolvedValue(createSourceHealthDetail());

    const html = await renderPage(incidentId);

    expect(html).toContain("Product feed could not be verified");
    expect(html).toContain("unavailable, partial, or blocked source");
    expect(html).toContain("No conclusion has been made about product availability");
    expect(html).toContain("resend_authentication_failed");
    expect(html).toContain("Dashboard detail comment");
    expect(html).toContain("Open URL");
    expect(html).not.toContain("metadata-must-not-render");
    expect(html).not.toContain("recipient@example.com");
    expect(html).not.toContain("provider.example.com");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain("products disappeared");
  });

  it("renders grouped Merchant issue triage without provider payload fields", async () => {
    const detail = createSourceHealthDetail();
    detail.incident = {
      ...detail.incident,
      type: "merchant_item_issues",
      title: "Merchant Center item issues",
      summary: "Products require Merchant Center remediation."
    };
    detail.merchantIssueSummary = {
      totalProducts: 2,
      totalIssues: 3,
      truncated: false,
      productsTruncated: false,
      issuesTruncated: false,
      groupsTruncated: false,
      issueGroups: [
        {
          code: "invalid_gtin",
          issueCount: 2,
          productCount: 1,
          priority: "critical",
          severities: ["error"],
          attributes: ["gtin"]
        }
      ],
      prioritizedProducts: [
        {
          stableKey: "offer:critical",
          offerId: "critical",
          title: "Critical product",
          priority: "critical",
          issueCount: 2,
          issueCodes: ["invalid_gtin"],
          affectedAttributes: ["gtin"]
        }
      ]
    };
    database.getDashboardIncidentDetail.mockResolvedValue(detail);

    const html = await renderPage(incidentId);

    expect(html).toContain("Remediation triage");
    expect(html).toContain("Invalid Gtin");
    expect(html).toContain("Critical product");
    expect(html).not.toContain("provider description");
    expect(html).not.toContain("documentationUrl");
  });
});

async function renderPage(id: string): Promise<string> {
  return renderToStaticMarkup(await IncidentDetailPage({ params: Promise.resolve({ id }) }));
}

function createSourceHealthDetail(): DashboardIncidentDetail {
  return {
    incident: {
      id: incidentId,
      storeId: "70000000-0000-4000-8000-000000000002",
      storeName: "Example store",
      type: "source_health",
      severity: "warning",
      status: "open",
      title: "Product feed could not be verified",
      summary: "The feed returned a source verification failure.",
      affectedCount: 0,
      likelySource: "feed",
      confidenceScore: null,
      firstDetectedAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:01:00.000Z"
    },
    store: {
      id: "70000000-0000-4000-8000-000000000002",
      name: "Example store",
      domain: "example.com"
    },
    timeline: [
      {
        id: "70000000-0000-4000-8000-000000000003",
        type: "incident_opened",
        reason: "Feed returned source_unavailable",
        fromStatus: null,
        toStatus: "open",
        metadata: { internal: "metadata-must-not-render" },
        createdAt: "2026-07-15T10:00:00.000Z"
      }
    ],
    signals: [
      {
        id: "70000000-0000-4000-8000-000000000004",
        type: "source_health",
        metric: "consecutive_failures",
        source: "feed",
        metrics: {
          beforeValue: 0,
          afterValue: 2,
          changeAbs: 2,
          changePct: 1
        },
        evidence: { sampleCount: 1 },
        createdAt: "2026-07-15T10:00:00.000Z"
      }
    ],
    samples: [
      {
        stableKey: "feed-item-1",
        offerId: "SKU-1",
        title: "Safe product",
        url: "https://example.com/products/safe"
      },
      {
        stableKey: "feed-item-2",
        offerId: "SKU-2",
        title: "Unsafe product",
        url: "javascript:alert('not-a-link')"
      }
    ],
    comments: [
      {
        id: "70000000-0000-4000-8000-000000000005",
        body: "Dashboard detail comment",
        createdAt: "2026-07-15T10:01:00.000Z"
      }
    ],
    alertDeliveries: [
      {
        channel: "email",
        status: "failed",
        attemptCount: 2,
        lastErrorCode: "resend_authentication_failed",
        sentAt: null
      }
    ]
  };
}
