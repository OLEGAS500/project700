import type { SourceCheckResult, SourceItemInput } from "@eim/core";
import {
  closePool,
  connectMerchantCenter,
  createOrUpdateMerchantItemIssuesIncident,
  createQueuedSnapshot,
  createStore,
  merchantItemIssuesConfigurationHash,
  persistMerchantCenterItemIssuesResult,
  withTransaction
} from "@eim/db";

const fixtureVersion = "merchant-remediation-qa-v1";
const fixtureAccountId = "990001";
const fixtureDomains = [
  "https://qa-merchant-remediation.example.test",
  "https://qa-merchant-remediation-isolation.example.test"
];
const defaultWebBaseUrl = "http://localhost:3000";
const queueItemCount = 60;

type IssueRecord = Record<string, unknown>;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required to seed the QA fixture.");
  }

  if (process.argv.includes("--cleanup")) {
    const removed = await cleanupFixture();
    console.log(`Removed QA fixture stores: ${removed}`);
    return;
  }

  const removed = await cleanupFixture();
  const target = await seedTargetStore();
  const isolation = await seedIsolationStore();
  const webBaseUrl = (process.env.WEB_BASE_URL?.trim() || defaultWebBaseUrl).replace(/\/$/, "");
  const emptyStateUrl = `${webBaseUrl}/incidents/${target.incidentId}?issueCode=qa_no_matching_products`;

  console.log("Merchant remediation QA fixture ready.");
  console.log(`Fixture version: ${fixtureVersion}`);
  console.log(`Previous fixture stores removed: ${removed}`);
  console.log(`Store ID: ${target.storeId}`);
  console.log(`Incident ID: ${target.incidentId}`);
  console.log(`Incident URL: ${webBaseUrl}/incidents/${target.incidentId}`);
  console.log(`Empty-state URL: ${emptyStateUrl}`);
  console.log(`Isolation store ID: ${isolation.storeId}`);
  console.log(`Opened snapshot ID: ${target.openedSnapshotId}`);
  console.log(`Later snapshot ID: ${target.laterSnapshotId}`);
  console.log(`Queue items in opened snapshot: ${queueItemCount}`);
  console.log("Expected pages at the default UI limit 25: 25 items, 25 items, then 10 items.");
  console.log("Cleanup command: npm run cleanup:merchant-remediation-qa");
}

async function cleanupFixture(): Promise<number> {
  return withTransaction(async (client) => {
    await client.query(
      `
        DELETE FROM alert_event_payloads
        WHERE store_id = ANY(
          SELECT id FROM stores WHERE domain = ANY($1::text[])
        )
      `,
      [fixtureDomains]
    );
    await client.query(
      `
        DELETE FROM alert_deliveries
        WHERE store_id = ANY(
          SELECT id FROM stores WHERE domain = ANY($1::text[])
        )
      `,
      [fixtureDomains]
    );
    const result = await client.query<{ id: string }>(
      `
        DELETE FROM stores
        WHERE domain = ANY($1::text[])
        RETURNING id
      `,
      [fixtureDomains]
    );
    return result.rows.length;
  });
}

async function seedTargetStore(): Promise<{
  storeId: string;
  incidentId: string;
  openedSnapshotId: string;
  laterSnapshotId: string;
}> {
  const created = await createStore({
    name: "QA Merchant Remediation Queue",
    domain: fixtureDomains[0],
    sitemapUrl: `${fixtureDomains[0]}/sitemap.xml`,
    feedUrl: `${fixtureDomains[0]}/feed.xml`,
    categoryUrls: [`${fixtureDomains[0]}/collections/all`]
  });
  await connectMerchantCenter(created.store.id, { merchantCenterAccountId: fixtureAccountId });

  const items = Array.from({ length: queueItemCount }, (_, index) => buildItem(index));
  const first = await createQueuedSnapshot(
    created.store.id,
    "normal_check",
    `${fixtureVersion}:target:first`
  );
  await persistMerchantCenterItemIssuesResult(
    first.id,
    created.store.id,
    buildResult(items, "2026-07-15T10:00:00.000Z")
  );
  await createOrUpdateMerchantItemIssuesIncident(created.store.id, first.id);

  const second = await createQueuedSnapshot(
    created.store.id,
    "normal_check",
    `${fixtureVersion}:target:opened`
  );
  await persistMerchantCenterItemIssuesResult(
    second.id,
    created.store.id,
    buildResult(items, "2026-07-15T10:05:00.000Z")
  );
  const incidentId = await createOrUpdateMerchantItemIssuesIncident(created.store.id, second.id);
  if (!incidentId) {
    throw new Error("QA fixture did not create a Merchant item-issues incident.");
  }

  const later = await createQueuedSnapshot(
    created.store.id,
    "normal_check",
    `${fixtureVersion}:target:later`
  );
  await persistMerchantCenterItemIssuesResult(
    later.id,
    created.store.id,
    buildResult([buildItem(999)], "2026-07-15T10:10:00.000Z")
  );

  return {
    storeId: created.store.id,
    incidentId,
    openedSnapshotId: second.id,
    laterSnapshotId: later.id
  };
}

async function seedIsolationStore(): Promise<{ storeId: string }> {
  const created = await createStore({
    name: "QA Merchant Remediation Isolation",
    domain: fixtureDomains[1],
    sitemapUrl: `${fixtureDomains[1]}/sitemap.xml`,
    feedUrl: `${fixtureDomains[1]}/feed.xml`,
    categoryUrls: [`${fixtureDomains[1]}/collections/all`]
  });
  await connectMerchantCenter(created.store.id, { merchantCenterAccountId: "990002" });

  const snapshot = await createQueuedSnapshot(
    created.store.id,
    "normal_check",
    `${fixtureVersion}:isolation`
  );
  await persistMerchantCenterItemIssuesResult(
    snapshot.id,
    created.store.id,
    buildResult([buildItem(700)], "2026-07-15T10:15:00.000Z", "990002")
  );
  return { storeId: created.store.id };
}

function buildResult(
  items: SourceItemInput[],
  startedAt: string,
  accountId = fixtureAccountId
): SourceCheckResult {
  return {
    source: "merchant_center",
    url: `https://merchantapi.googleapis.com/products/v1/accounts/${accountId}/products`,
    status: "success",
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(),
    durationMs: 1_000,
    itemsObserved: items.length,
    totalItemsSeen: items.length,
    skippedItems: 0,
    items,
    metadata: {
      merchantItemIssuesVersion: "v1",
      merchantItemIssuesConfigurationHash: merchantItemIssuesConfigurationHash(accountId),
      productsSeen: items.length,
      productsWithIssues: items.length,
      issuesObserved: items.reduce(
        (total, item) => total + (item.merchantIssues?.length ?? 0),
        0
      ),
      pagination: { pagesFetched: 1, complete: true }
    }
  };
}

function buildItem(index: number): SourceItemInput {
  const severity = index % 3 === 0 ? "error" : index % 3 === 1 ? "warning" : "info";
  const stableKey =
    index === 0
      ? `offer:qa-${"a".repeat(248)}😀`
      : `offer:qa-${String(index).padStart(3, "0")}`;
  const title = index === 0 ? `Boundary title ${"😀".repeat(120)}` : `QA product ${index}`;
  const offerId = index === 0 ? `qa-${"o".repeat(240)}😀` : `qa-offer-${index}`;
  const issues: IssueRecord[] = [
    issue(`qa_issue_${index}`, severity, index % 2 === 0 ? "price" : "availability")
  ];

  if (index === 0) {
    const boundedPrefix = `qa_${"x".repeat(253)}`;
    const attributePrefix = `${"a".repeat(254)}😀`;
    issues.push(
      issue(`${boundedPrefix}A`, "error", `${attributePrefix}X`),
      issue(`${boundedPrefix}B`, "error", `${attributePrefix}Y`),
      { code: 42, severity: "error", attribute: "malformed" }
    );
    for (let issueIndex = 0; issueIndex < 102; issueIndex += 1) {
      issues.push(issue(`qa_nested_${issueIndex}`, "warning", `field_${issueIndex}`));
    }
  }

  return {
    source: "merchant_center",
    stableKey,
    offerId,
    title,
    url: `https://qa-merchant-remediation.example.test/products/${index}`,
    merchantStatus: "disapproved",
    merchantIssues: issues,
    metadata: {
      merchantDataKind: "item_issues",
      productName: `accounts/${fixtureAccountId}/products/${offerId}`
    },
    rawHash: `${fixtureVersion}:${index}:${severity}`
  };
}

function issue(code: string, severity: string, attribute: string): IssueRecord {
  return {
    code,
    severity,
    resolution: "merchant_action",
    attribute,
    reportingContext: "shopping_ads",
    description: "QA-only issue fixture",
    applicableCountries: ["US"]
  };
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "QA fixture operation failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
