import { createHash } from "node:crypto";
import type { QueuedSnapshot } from "@eim/core";
import {
  claimDueIncidentConfirmationCandidates,
  createQueuedSnapshot,
  confirmFeedCatalogDropCandidate,
  createOrUpdateFeedSourceHealthIncident,
  createOrUpdatePriceAvailabilityMismatchIncident,
  createOrUpdateMerchantItemIssuesIncident,
  createOrUpdateSeoRegressionIncident,
  createOrUpdateSourceDivergenceIncident,
  evaluateFeedCatalogDropCandidate,
  updateCatalogDropRecovery,
  updatePriceAvailabilityRecovery,
  updateMerchantItemIssuesRecovery,
  updateSeoRegressionRecovery,
  updateSourceDivergenceRecovery,
  getLatestQueuedSnapshotForStore,
  listMatchableSourceItems,
  getSnapshotStore,
  listProductPageCandidates,
  listMonitoredCategories,
  markIncidentConfirmationAttemptFailed,
  persistSampleManifest,
  persistFeedCheckResult,
  persistSourceCheckResult,
  persistMerchantCenterItemIssuesResult,
  persistSitemapCheckResult,
  replaceSourceMatches
} from "@eim/db";
import { collectCategory } from "./sources/category";
import { collectFeed } from "./sources/feed";
import { collectProductPage } from "./sources/product-page";
import { collectSitemap } from "./sources/sitemap";
import { buildSourceMatches } from "./source-matching";
import { collectMerchantCenterProductStatuses } from "./merchant-center-status";
import { collectMerchantCenterItemIssues } from "./merchant-center-item-issues";

export type SnapshotJob = {
  snapshotId: string;
  storeId: string;
  reason: "store_created" | "manual" | "scheduled" | "confirmation";
  scheduledFor?: string;
};

export type IncidentConfirmationJob = {
  candidateId: string;
  storeId: string;
  scheduledFor: string;
};

const inMemoryQueue: SnapshotJob[] = [];
const queuedKeys = new Set<string>();
const incidentConfirmationQueue: IncidentConfirmationJob[] = [];
const incidentConfirmationKeys = new Set<string>();

export async function enqueueSnapshotJob(job: SnapshotJob): Promise<QueuedSnapshot> {
  const baselineRole = job.reason === "confirmation" ? "confirmation_check" : "candidate";
  const scheduledWindow = toMinuteWindow(job.scheduledFor ?? new Date().toISOString());
  const queueKey = `${job.storeId}:${baselineRole}:${scheduledWindow}`;

  if (!queuedKeys.has(queueKey)) {
    queuedKeys.add(queueKey);
    inMemoryQueue.push({
      ...job,
      scheduledFor: scheduledWindow
    });
  }

  return {
    id: job.snapshotId,
    storeId: job.storeId,
    status: "queued",
    baselineRole,
    createdAt: new Date().toISOString()
  };
}

export function getQueuedSnapshotJobs(): SnapshotJob[] {
  return [...inMemoryQueue];
}

export function getQueuedIncidentConfirmationJobs(): IncidentConfirmationJob[] {
  return [...incidentConfirmationQueue];
}

export function clearQueuedSnapshotJobs(): void {
  inMemoryQueue.length = 0;
  queuedKeys.clear();
  incidentConfirmationQueue.length = 0;
  incidentConfirmationKeys.clear();
}

export async function runSitemapSnapshotForStore(storeId: string): Promise<{
  snapshotId: string;
  sitemapUrlCount: number | null;
  status: "queued" | "running" | "completed" | "partial" | "failed";
}> {
  const queued =
    (await getLatestQueuedSnapshotForStore(storeId)) ??
    (await createQueuedSnapshot(
      storeId,
      "candidate",
      `manual:${storeId}:${toMinuteWindow(new Date().toISOString())}`
    ));

  const store = await getSnapshotStore(queued.id);

  if (!store) {
    throw new Error(`Snapshot ${queued.id} does not belong to an existing store`);
  }

  const result = await collectSitemap({
    url: store.sitemapUrl
  });

  const snapshot = await persistSitemapCheckResult(queued.id, store.id, result);

  return {
    snapshotId: snapshot.id,
    sitemapUrlCount: snapshot.sitemapUrlCount,
    status: snapshot.status
  };
}

export async function runSourceSnapshotForStore(storeId: string): Promise<{
  snapshotId: string;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  sitemapUrlCount: number | null;
  feedProductCount: number | null;
  merchantTotalCount: number | null;
  merchantApprovedCount: number | null;
  merchantPendingCount: number | null;
  merchantDisapprovedCount: number | null;
}> {
  const queued =
    (await getLatestQueuedSnapshotForStore(storeId)) ??
    (await createQueuedSnapshot(
      storeId,
      "candidate",
      `manual:${storeId}:${toMinuteWindow(new Date().toISOString())}`
    ));

  const store = await getSnapshotStore(queued.id);

  if (!store) {
    throw new Error(`Snapshot ${queued.id} does not belong to an existing store`);
  }

  const sitemapResult = await collectSitemap({
    url: store.sitemapUrl
  });
  await persistSitemapCheckResult(queued.id, store.id, sitemapResult);

  const feedResult = await collectFeed({
    url: store.feedUrl
  });
  let snapshot = await persistFeedCheckResult(queued.id, store.id, feedResult);

  if (store.merchantCenterAccountId) {
    const merchantStatusResult = await collectMerchantCenterProductStatuses({
      storeId: store.id,
      accountId: store.merchantCenterAccountId
    });
    snapshot = await persistSourceCheckResult(
      queued.id,
      store.id,
      merchantStatusResult
    );

    const merchantItemIssuesResult = await collectMerchantCenterItemIssues({
      storeId: store.id,
      accountId: store.merchantCenterAccountId
    });
    snapshot = await persistMerchantCenterItemIssuesResult(
      queued.id,
      store.id,
      merchantItemIssuesResult
    );
  }

  const categories = await listMonitoredCategories(store.id);

  for (const category of categories) {
    const categoryResult = await collectCategory({
      url: category.url
    });
    snapshot = await persistSourceCheckResult(queued.id, store.id, categoryResult);
  }

  const requestedSampleSize = 25;
  const productPageUrls = await listProductPageCandidates(
    queued.id,
    store.id,
    requestedSampleSize
  );

  await persistSampleManifest(queued.id, {
    sampleStrategy: "stable_hash_v1",
    productPageParserVersion: "product_page_parser_v1",
    normalizationVersion: "product_page_normalizer_v1",
    schemaValidationVersion: "schema_valid_enough_v1",
    requestedSampleSize,
    selectedCount: productPageUrls.length,
    selectedUrlsHash: createHash("sha256")
      .update(JSON.stringify(productPageUrls))
      .digest("hex"),
    selectedUrls: productPageUrls
  });

  for (const productPageUrl of productPageUrls) {
    const productPageResult = await collectProductPage({
      url: productPageUrl
    });
    snapshot = await persistSourceCheckResult(queued.id, store.id, productPageResult);
  }

  const matchableItems = await listMatchableSourceItems(queued.id, store.id);
  await replaceSourceMatches(
    queued.id,
    store.id,
    buildSourceMatches(matchableItems)
  );

  await createOrUpdateSourceDivergenceIncident(store.id, queued.id);
  await updateSourceDivergenceRecovery(store.id, queued.id);
  await createOrUpdateMerchantItemIssuesIncident(store.id, queued.id);
  await updateMerchantItemIssuesRecovery(store.id, queued.id);
  await createOrUpdateFeedSourceHealthIncident(store.id, queued.id);
  await createOrUpdateSeoRegressionIncident(store.id, queued.id);
  await updateSeoRegressionRecovery(store.id, queued.id);
  await createOrUpdatePriceAvailabilityMismatchIncident(store.id, queued.id);
  await updatePriceAvailabilityRecovery(store.id, queued.id);
  const candidate = await evaluateFeedCatalogDropCandidate(store.id, queued.id);
  await updateCatalogDropRecovery(store.id, queued.id);

  if (candidate) {
    enqueueIncidentConfirmationJob({
      candidateId: candidate.id,
      storeId: candidate.storeId,
      scheduledFor: candidate.confirmationDueAt
    });
  }

  return {
    snapshotId: snapshot.id,
    status: snapshot.status,
    sitemapUrlCount: snapshot.sitemapUrlCount,
    feedProductCount: snapshot.feedProductCount,
    merchantTotalCount: snapshot.merchantTotalCount,
    merchantApprovedCount: snapshot.merchantApprovedCount,
    merchantPendingCount: snapshot.merchantPendingCount,
    merchantDisapprovedCount: snapshot.merchantDisapprovedCount
  };
}

export async function runFeedIncidentConfirmationJob(
  job: IncidentConfirmationJob
): Promise<{ candidateId: string; incidentId: string | null }> {
  const snapshot = await createQueuedSnapshot(
    job.storeId,
    "confirmation_check",
    `confirmation:${job.candidateId}:${toMinuteWindow(job.scheduledFor)}`
  );
  const store = await getSnapshotStore(snapshot.id);

  if (!store) {
    throw new Error(`Confirmation snapshot ${snapshot.id} does not belong to an existing store`);
  }

  const feedResult = await collectFeed({
    url: store.feedUrl
  });
  await persistFeedCheckResult(snapshot.id, store.id, feedResult);
  await createOrUpdateFeedSourceHealthIncident(store.id, snapshot.id);
  const result = await confirmFeedCatalogDropCandidate(job.candidateId, snapshot.id);

  return {
    candidateId: result.candidate.id,
    incidentId: result.incidentId
  };
}

export async function runDueIncidentConfirmationJobs(limit = 10, workerId = "worker"): Promise<Array<{
  candidateId: string;
  incidentId: string | null;
  status: "completed" | "failed";
}>> {
  const jobs = await claimDueIncidentConfirmationCandidates(limit, workerId);
  const results: Array<{
    candidateId: string;
    incidentId: string | null;
    status: "completed" | "failed";
  }> = [];

  for (const job of jobs) {
    try {
      const result = await runFeedIncidentConfirmationJob(job);
      results.push({
        ...result,
        status: "completed"
      });
    } catch (error) {
      await markIncidentConfirmationAttemptFailed(job.candidateId, error);
      results.push({
        candidateId: job.candidateId,
        incidentId: null,
        status: "failed"
      });
    }
  }

  return results;
}

function enqueueIncidentConfirmationJob(job: IncidentConfirmationJob): void {
  const key = `${job.storeId}:${job.candidateId}:${toMinuteWindow(job.scheduledFor)}`;

  if (incidentConfirmationKeys.has(key)) {
    return;
  }

  incidentConfirmationKeys.add(key);
  incidentConfirmationQueue.push({
    ...job,
    scheduledFor: toMinuteWindow(job.scheduledFor)
  });
}

function toMinuteWindow(value: string): string {
  const date = new Date(value);
  date.setSeconds(0, 0);
  return date.toISOString();
}
