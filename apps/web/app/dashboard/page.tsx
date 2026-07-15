import { listDashboardStoreSummaries } from "@eim/db";
import type { DashboardStoreSource, DashboardStoreSummary } from "@eim/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

const sourceOrder = ["feed", "sitemap", "category", "product_page", "merchant_center"] as const;

const sourceLabels: Record<(typeof sourceOrder)[number], string> = {
  feed: "Feed",
  sitemap: "Sitemap",
  category: "Categories",
  product_page: "Product pages",
  merchant_center: "Merchant Center"
};

export default async function DashboardPage() {
  let stores: DashboardStoreSummary[] = [];
  let failedToLoad = false;

  try {
    stores = await listDashboardStoreSummaries();
  } catch {
    failedToLoad = true;
  }

  const metrics = buildMetrics(stores);

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <Link className="product-mark" href="/">
            EIM
          </Link>
          <h1>Stores overview</h1>
          <p>Current source observations and active business incidents across every store.</p>
        </div>
        <Link className="primary-link" href="/">
          Add store
        </Link>
      </header>

      {failedToLoad ? <DashboardFailureState /> : null}

      {!failedToLoad ? (
        <>
          <dl className="dashboard-summary" aria-label="Dashboard totals">
            <SummaryMetric label="Stores" value={metrics.storeCount} />
            <SummaryMetric label="Active incidents" value={metrics.activeIncidentCount} />
            <SummaryMetric label="Critical incidents" value={metrics.criticalIncidentCount} tone="critical" />
            <SummaryMetric
              label="Stores with source check issues"
              value={metrics.storesWithSourceIssues}
              tone={metrics.storesWithSourceIssues > 0 ? "attention" : undefined}
            />
          </dl>

          {stores.length === 0 ? (
            <DashboardEmptyState />
          ) : (
            <section className="dashboard-table-region" aria-labelledby="dashboard-stores-heading">
              <div className="dashboard-table-heading">
                <div>
                  <h2 id="dashboard-stores-heading">Monitored stores</h2>
                  <p>Source counts are observations, not confirmed product-loss claims.</p>
                </div>
                <span>{stores.length} total</span>
              </div>

              <div className="dashboard-table-scroll">
                <table className="dashboard-table">
                  <thead>
                    <tr>
                      <th scope="col">Store</th>
                      <th scope="col">Baseline</th>
                      <th scope="col">Source observations</th>
                      <th scope="col">Business incidents</th>
                      <th scope="col">Last check</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stores.map((store) => (
                      <StoreRow key={store.id} store={store} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      ) : null}
    </main>
  );
}

function StoreRow({ store }: { store: DashboardStoreSummary }) {
  const hasSourceIssue = store.sources.some(isSourceIssue);

  return (
    <tr>
      <th scope="row">
        <div className="store-cell">
          <strong>{store.name}</strong>
          <span>{store.domain}</span>
          {hasSourceIssue ? <span className="source-issue-note">Source check issue</span> : null}
        </div>
      </th>
      <td>
        <span className={`baseline-status baseline-${store.baseline.status ?? "unknown"}`}>
          {baselineLabel(store.baseline.status)}
        </span>
        <span className="baseline-updated">{formatTimestamp(store.baseline.updatedAt)}</span>
      </td>
      <td>
        <div className="source-observations">
          {sourceOrder.map((source) => {
            const observation = store.sources.find((item) => item.source === source) ?? null;
            return <SourceObservation key={source} source={source} observation={observation} />;
          })}
        </div>
      </td>
      <td>
        <div className="incident-counts">
          <strong>{store.incidents.open + store.incidents.recovering} active</strong>
          <span>{store.incidents.critical} critical</span>
          {store.incidents.recovering > 0 ? <span>{store.incidents.recovering} recovering</span> : null}
        </div>
      </td>
      <td className="last-check">{formatTimestamp(store.lastCheckedAt)}</td>
    </tr>
  );
}

function SourceObservation({
  source,
  observation
}: {
  source: (typeof sourceOrder)[number];
  observation: DashboardStoreSource | null;
}) {
  const status = observation?.status ?? null;
  const count = observation?.observedCount;

  return (
    <div className="source-observation">
      <span>{sourceLabels[source]}</span>
      <strong>{count === null || count === undefined ? "-" : count.toLocaleString("en")}</strong>
      <em className={`source-status source-${sourceStatusTone(status)}`}>
        {sourceStatusLabel(status)}
      </em>
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  tone
}: {
  label: string;
  value: number;
  tone?: "critical" | "attention";
}) {
  return (
    <div className={tone ? `summary-${tone}` : undefined}>
      <dt>{label}</dt>
      <dd>{value.toLocaleString("en")}</dd>
    </div>
  );
}

function DashboardEmptyState() {
  return (
    <section className="dashboard-empty-state">
      <h2>No stores yet</h2>
      <p>Add a store to begin baseline learning and collect the first source observations.</p>
      <Link className="primary-link" href="/">
        Add first store
      </Link>
    </section>
  );
}

function DashboardFailureState() {
  return (
    <section className="dashboard-failure-state" role="alert">
      <h2>Dashboard data is unavailable</h2>
      <p>The overview could not be read right now. Check the database connection and try again.</p>
      <Link href="/dashboard">Try again</Link>
    </section>
  );
}

function buildMetrics(stores: DashboardStoreSummary[]) {
  return stores.reduce(
    (metrics, store) => ({
      storeCount: metrics.storeCount + 1,
      activeIncidentCount: metrics.activeIncidentCount + store.incidents.open + store.incidents.recovering,
      criticalIncidentCount: metrics.criticalIncidentCount + store.incidents.critical,
      storesWithSourceIssues: metrics.storesWithSourceIssues + Number(store.sources.some(isSourceIssue))
    }),
    {
      storeCount: 0,
      activeIncidentCount: 0,
      criticalIncidentCount: 0,
      storesWithSourceIssues: 0
    }
  );
}

function isSourceIssue(source: DashboardStoreSource): boolean {
  return source.status !== null && source.status !== "success";
}

function baselineLabel(status: DashboardStoreSummary["baseline"]["status"]): string {
  if (status === "active") return "Active";
  if (status === "pending_user_confirmation") return "Needs confirmation";
  if (status === "learning") return "Learning";
  return "Not available";
}

function sourceStatusTone(status: DashboardStoreSource["status"]): string {
  if (status === "success") return "healthy";
  if (status === "partial") return "attention";
  if (status === null) return "neutral";
  return "unavailable";
}

function sourceStatusLabel(status: DashboardStoreSource["status"]): string {
  if (status === "success") return "Checked";
  if (status === "partial") return "Partial";
  if (status === null) return "Not checked";
  return "Source issue";
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Not checked";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short"
  }).format(new Date(value));
}
