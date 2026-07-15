import {
  incidentLikelySourceSchema,
  incidentSeveritySchema,
  incidentStatusSchema,
  incidentTypeSchema
} from "@eim/core";
import {
  InvalidDashboardCursorError,
  listDashboardIncidents,
  listDashboardStoreSummaries
} from "@eim/db";
import type {
  DashboardIncidentListInput,
  DashboardIncidentListItem,
  DashboardStoreSummary
} from "@eim/db";
import Link from "next/link";
import type { ReactNode } from "react";
import { parseDashboardIncidentQuery } from "../../lib/dashboard-incident-query";

export const dynamic = "force-dynamic";

type IncidentPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const statusLabels = {
  open: "Open",
  investigating: "Investigating",
  acknowledged: "Acknowledged",
  recovering: "Recovering",
  resolved: "Resolved",
  ignored: "Ignored"
} as const;

const severityLabels = {
  critical: "Critical",
  warning: "Warning",
  info: "Info"
} as const;

const typeLabels = {
  catalog_drop: "Catalog drop",
  source_divergence: "Source divergence",
  seo_regression: "SEO regression",
  price_availability_mismatch: "Price / availability mismatch",
  source_health: "Source health",
  merchant_item_issues: "Merchant Center item issues"
} as const;

const likelySourceLabels = {
  feed: "Feed",
  sitemap: "Sitemap",
  category: "Category",
  product_page: "Product page",
  merchant_center: "Merchant Center",
  feed_or_publication: "Feed or publication",
  feed_or_storefront_product_data: "Feed or storefront product data",
  site_template_or_deployment: "Site template or deployment"
} as const;

export default async function IncidentsPage({ searchParams }: IncidentPageProps) {
  const search = toUrlSearchParams(await searchParams);
  const parsed = parseDashboardIncidentQuery(search);

  if (!parsed.success) {
    return (
      <IncidentsLayout>
        <InvalidQueryState />
      </IncidentsLayout>
    );
  }

  let data:
    | {
        incidents: DashboardIncidentListItem[];
        nextCursor: string | null;
        stores: DashboardStoreSummary[];
      }
    | undefined;
  let invalidCursor = false;

  try {
    const [{ incidents, nextCursor }, stores] = await Promise.all([
      listDashboardIncidents(parsed.data),
      listDashboardStoreSummaries()
    ]);
    data = { incidents, nextCursor, stores };
  } catch (error) {
    invalidCursor = error instanceof InvalidDashboardCursorError;
  }

  if (invalidCursor) {
    return (
      <IncidentsLayout>
        <InvalidQueryState />
      </IncidentsLayout>
    );
  }

  if (!data) {
    return (
      <IncidentsLayout>
        <IncidentReadFailureState />
      </IncidentsLayout>
    );
  }

  return (
    <IncidentsLayout>
      <IncidentFilterForm filters={parsed.data} stores={data.stores} />
      {data.incidents.length === 0 ? (
        <EmptyIncidentState hasFilters={hasSelectedFilters(parsed.data) || Boolean(parsed.data.cursor)} />
      ) : (
        <section className="dashboard-table-region incident-table-region" aria-labelledby="incidents-heading">
          <div className="dashboard-table-heading">
            <div>
              <h2 id="incidents-heading">Incident queue</h2>
              <p>Current and historical grouped incidents across monitored stores.</p>
            </div>
            <span>{data.incidents.length} shown</span>
          </div>
          <IncidentTable incidents={data.incidents} />
          {data.nextCursor ? (
            <div className="incident-pagination">
              <Link className="primary-link" href={buildIncidentListHref(parsed.data, data.nextCursor)}>
                Next page
              </Link>
            </div>
          ) : null}
        </section>
      )}
    </IncidentsLayout>
  );
}

function IncidentsLayout({ children }: { children: ReactNode }) {
  return (
    <main className="dashboard-shell incident-list-shell">
      <header className="dashboard-header incident-list-header">
        <div>
          <Link className="product-mark" href="/dashboard">
            EIM
          </Link>
          <h1>Incidents</h1>
          <p>Operational and business incidents, with their current evidence and lifecycle status.</p>
        </div>
        <Link className="back-link" href="/dashboard">
          Stores overview
        </Link>
      </header>
      {children}
    </main>
  );
}

function IncidentFilterForm({
  filters,
  stores
}: {
  filters: DashboardIncidentListInput;
  stores: DashboardStoreSummary[];
}) {
  const showClear = hasSelectedFilters(filters);

  return (
    <form className="incident-filter-form" action="/incidents" method="get">
      <div className="incident-filter-grid">
        <FilterField label="Store" name="storeId" value={filters.storeId}>
          <option value="">All stores</option>
          {stores.map((store) => (
            <option key={store.id} value={store.id}>
              {store.name} ({store.domain})
            </option>
          ))}
        </FilterField>
        <FilterField label="Status" name="status" value={filters.status}>
          <option value="">All statuses</option>
          {incidentStatusSchema.options.map((status) => (
            <option key={status} value={status}>
              {statusLabels[status]}
            </option>
          ))}
        </FilterField>
        <FilterField label="Severity" name="severity" value={filters.severity}>
          <option value="">All severities</option>
          {incidentSeveritySchema.options.map((severity) => (
            <option key={severity} value={severity}>
              {severityLabels[severity]}
            </option>
          ))}
        </FilterField>
        <FilterField label="Type" name="type" value={filters.type}>
          <option value="">All types</option>
          {incidentTypeSchema.options.map((type) => (
            <option key={type} value={type}>
              {typeLabels[type]}
            </option>
          ))}
        </FilterField>
        <FilterField label="Likely source" name="likelySource" value={filters.likelySource}>
          <option value="">All likely sources</option>
          {incidentLikelySourceSchema.options.map((source) => (
            <option key={source} value={source}>
              {likelySourceLabels[source]}
            </option>
          ))}
        </FilterField>
      </div>
      <div className="incident-filter-actions">
        <button type="submit">Apply filters</button>
        {showClear ? <Link href="/incidents">Clear filters</Link> : null}
      </div>
    </form>
  );
}

function FilterField({
  label,
  name,
  value,
  children
}: {
  label: string;
  name: string;
  value: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="incident-filter-field">
      <span>{label}</span>
      <select defaultValue={value ?? ""} name={name}>
        {children}
      </select>
    </label>
  );
}

function IncidentTable({ incidents }: { incidents: DashboardIncidentListItem[] }) {
  return (
    <div className="dashboard-table-scroll">
      <table className="dashboard-table incident-list-table">
        <thead>
          <tr>
            <th scope="col">Incident</th>
            <th scope="col">Store</th>
            <th scope="col">Severity</th>
            <th scope="col">Status</th>
            <th scope="col">Affected</th>
            <th scope="col">Likely source</th>
            <th scope="col">Confidence</th>
            <th scope="col">First detected</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {incidents.map((incident) => (
            <tr key={incident.id}>
              <th scope="row">
                <div className="incident-title-cell">
                  <Link className="incident-detail-link" href={"/incidents/" + incident.id}>
                    {incident.title}
                  </Link>
                  <span>{typeLabels[incident.type]}</span>
                  <p>{incident.summary}</p>
                </div>
              </th>
              <td className="incident-store-cell">{incident.storeName}</td>
              <td>
                <span className={["incident-badge", "incident-severity-" + incident.severity].join(" ")}>
                  {severityLabels[incident.severity]}
                </span>
              </td>
              <td>
                <span className={["incident-badge", "incident-status-" + incident.status].join(" ")}>
                  {statusLabels[incident.status]}
                </span>
              </td>
              <td className="incident-number">{incident.affectedCount.toLocaleString("en")}</td>
              <td className="incident-likely-source">
                {incident.likelySource ? likelySourceLabels[incident.likelySource] : "Not classified"}
              </td>
              <td className="incident-number">{formatConfidence(incident.confidenceScore)}</td>
              <td className="incident-timestamp">{formatTimestamp(incident.firstDetectedAt)}</td>
              <td className="incident-timestamp">{formatTimestamp(incident.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyIncidentState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <section className="incident-state">
      <h2>{hasFilters ? "No incidents match these filters" : "No incidents yet"}</h2>
      <p>
        {hasFilters
          ? "Try broadening the filters to review other incident groups."
          : "Detected incident groups will appear here when monitoring identifies a confirmed business issue or a source-health problem."}
      </p>
      {hasFilters ? <Link href="/incidents">Clear filters</Link> : null}
    </section>
  );
}

function InvalidQueryState() {
  return (
    <section className="incident-state incident-state-warning" role="alert">
      <h2>Invalid incident filters</h2>
      <p>The requested filter combination cannot be applied. Start again with the supported filters.</p>
      <Link href="/incidents">Reset filters</Link>
    </section>
  );
}

function IncidentReadFailureState() {
  return (
    <section className="incident-state incident-state-failure" role="alert">
      <h2>Incident data is unavailable</h2>
      <p>The incident list could not be read right now. Check the database connection and try again.</p>
      <Link href="/incidents">Try again</Link>
    </section>
  );
}

function buildIncidentListHref(filters: DashboardIncidentListInput, cursor: string): string {
  const search = new URLSearchParams();

  for (const [name, value] of Object.entries(filters)) {
    if (name !== "cursor" && value !== undefined) {
      search.set(name, String(value));
    }
  }

  search.set("cursor", cursor);
  return `/incidents?${search.toString()}`;
}

function hasSelectedFilters(filters: DashboardIncidentListInput): boolean {
  return Boolean(
    filters.storeId || filters.status || filters.severity || filters.type || filters.likelySource
  );
}

function toUrlSearchParams(
  searchParams: Record<string, string | string[] | undefined>
): URLSearchParams {
  const search = new URLSearchParams();

  for (const [name, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const entry of value) search.append(name, entry);
    } else if (typeof value === "string") {
      search.append(name, value);
    }
  }

  return search;
}

function formatConfidence(value: number | null): string {
  return value === null ? "-" : `${Math.round(value * 100)}%`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short"
  }).format(new Date(value));
}
