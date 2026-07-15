import { getDashboardIncidentDetail } from "@eim/db";
import type { DashboardIncidentDetail } from "@eim/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import IncidentActions from "./incident-actions";
import {
  formatIdentifier,
  incidentContext,
  safeExternalUrl,
  statusTransitionLabel
} from "../../../lib/incident-detail-view";

export const dynamic = "force-dynamic";

type IncidentDetailPageProps = {
  params: Promise<{ id: string }>;
};

const incidentIdSchema = z.string().uuid();

const severityLabels = {
  critical: "Critical",
  warning: "Warning",
  info: "Info"
} as const;

const statusLabels = {
  open: "Open",
  investigating: "Investigating",
  acknowledged: "Acknowledged",
  recovering: "Recovering",
  resolved: "Resolved",
  ignored: "Ignored"
} as const;

export default async function IncidentDetailPage({ params }: IncidentDetailPageProps) {
  const { id } = await params;
  const parsedId = incidentIdSchema.safeParse(id);

  if (!parsedId.success) {
    return <DetailState kind="invalid" />;
  }

  let detail: DashboardIncidentDetail | null | undefined;
  let readFailed = false;

  try {
    detail = await getDashboardIncidentDetail(parsedId.data);
  } catch {
    readFailed = true;
  }

  if (readFailed) return <DetailState kind="failure" />;

  if (!detail) {
    notFound();
  }

  const { incident, store } = detail;
  const sourceHealthContext = incidentContext(incident.type);

  return (
    <main className="dashboard-shell incident-detail-shell">
      <header className="detail-header">
        <Link className="back-link" href="/incidents">
          All incidents
        </Link>
        <p className="detail-store-name">
          {store.name} <span>{store.domain}</span>
        </p>
        <div className="detail-heading-row">
          <div>
            <h1>{incident.title}</h1>
            <p className="detail-summary">{incident.summary}</p>
          </div>
          <div className="detail-badges" aria-label="Incident status">
            <span className={["incident-badge", "incident-severity-" + incident.severity].join(" ")}>
              {severityLabels[incident.severity]}
            </span>
            <span className={["incident-badge", "incident-status-" + incident.status].join(" ")}>
              {statusLabels[incident.status]}
            </span>
          </div>
        </div>
        {sourceHealthContext ? <p className="detail-source-health-note">{sourceHealthContext}</p> : null}
      </header>

      <dl className="detail-facts">
        <DetailFact label="Incident type" value={formatIdentifier(incident.type)} />
        <DetailFact label="Affected" value={incident.affectedCount.toLocaleString("en")} />
        <DetailFact label="Confidence" value={formatConfidence(incident.confidenceScore)} />
        <DetailFact
          label="Likely source"
          value={incident.likelySource ? formatIdentifier(incident.likelySource) : "Not classified"}
        />
        <DetailFact label="First detected" value={formatTimestamp(incident.firstDetectedAt)} />
        <DetailFact label="Last updated" value={formatTimestamp(incident.updatedAt)} />
      </dl>

      <IncidentActions incidentId={incident.id} status={incident.status} />
      <SignalSection signals={detail.signals} />
      <MerchantIssueTriageSection summary={detail.merchantIssueSummary} />
      <SampleSection samples={detail.samples} />
      <TimelineSection timeline={detail.timeline} />
      <CommentSection comments={detail.comments} />
      <AlertDeliverySection deliveries={detail.alertDeliveries} />
    </main>
  );
}

function DetailState({ kind }: { kind: "invalid" | "failure" }) {
  const content = {
    invalid: {
      title: "Invalid incident link",
      message: "This incident identifier is not valid.",
      className: "incident-state-warning"
    },
    failure: {
      title: "Incident data is unavailable",
      message: "The incident detail could not be read right now. Check the database connection and try again.",
      className: "incident-state-failure"
    }
  }[kind];

  return (
    <main className="dashboard-shell incident-detail-shell">
      <Link className="back-link" href="/incidents">
        All incidents
      </Link>
      <section className={["incident-state", content.className].filter(Boolean).join(" ")} role="alert">
        <h1>{content.title}</h1>
        <p>{content.message}</p>
        <Link href="/incidents">Back to incidents</Link>
      </section>
    </main>
  );
}

function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SignalSection({ signals }: { signals: DashboardIncidentDetail["signals"] }) {
  return (
    <DetailSection title="Signals" description="Measured changes used to group this incident.">
      {signals.length === 0 ? (
        <EmptyDetailSection message="No signals were recorded for this incident." />
      ) : (
        <div className="detail-table-scroll">
          <table className="detail-table signal-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Metric</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
                <th scope="col">Absolute change</th>
                <th scope="col">Percentage change</th>
                <th scope="col">Samples</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((signal) => (
                <tr key={signal.id}>
                  <td>{signal.source ? formatIdentifier(signal.source) : "Not classified"}</td>
                  <td>{formatIdentifier(signal.metric)}</td>
                  <td>{formatNumber(signal.metrics.beforeValue)}</td>
                  <td>{formatNumber(signal.metrics.afterValue)}</td>
                  <td>{formatNumber(signal.metrics.changeAbs)}</td>
                  <td>{formatPercent(signal.metrics.changePct)}</td>
                  <td>{signal.evidence.sampleCount.toLocaleString("en")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DetailSection>
  );
}

function MerchantIssueTriageSection({
  summary
}: {
  summary: DashboardIncidentDetail["merchantIssueSummary"];
}) {
  if (!summary) return null;

  return (
    <DetailSection
      title="Remediation triage"
      description="Grouped Merchant Center issue codes and the highest-priority affected products."
    >
      <dl className="detail-facts">
        <DetailFact label="Affected products" value={summary.totalProducts.toLocaleString("en")} />
        <DetailFact label="Normalized issues" value={summary.totalIssues.toLocaleString("en")} />
        <DetailFact label="Issue groups" value={summary.issueGroups.length.toLocaleString("en")} />
      </dl>

      {summary.issueGroups.length === 0 ? (
        <EmptyDetailSection message="No normalized issue codes are available for triage." />
      ) : (
        <>
          <h3 className="detail-subheading">Grouped issue codes</h3>
          <div className="detail-table-scroll">
            <table className="detail-table merchant-issue-group-table">
              <thead>
                <tr>
                  <th scope="col">Issue code</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Issues</th>
                  <th scope="col">Products</th>
                  <th scope="col">Attributes</th>
                </tr>
              </thead>
              <tbody>
                {summary.issueGroups.map((group) => (
                  <tr key={group.code}>
                    <td>{formatIdentifier(group.code)}</td>
                    <td>{formatIdentifier(group.priority)}</td>
                    <td>{group.issueCount.toLocaleString("en")}</td>
                    <td>{group.productCount.toLocaleString("en")}</td>
                    <td>{group.attributes.map(formatIdentifier).join(", ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="detail-subheading">Priority products</h3>
          {summary.prioritizedProducts.length === 0 ? (
            <EmptyDetailSection message="No affected products are available for triage." />
          ) : (
            <div className="detail-table-scroll">
              <table className="detail-table merchant-issue-product-table">
                <thead>
                  <tr>
                    <th scope="col">Priority</th>
                    <th scope="col">Product</th>
                    <th scope="col">Stable key</th>
                    <th scope="col">Issue codes</th>
                    <th scope="col">Attributes</th>
                    <th scope="col">Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.prioritizedProducts.map((product) => (
                    <tr key={product.stableKey ?? product.offerId ?? product.title}>
                      <td>{formatIdentifier(product.priority)}</td>
                      <td>{product.title ?? product.offerId ?? "Unnamed product"}</td>
                      <td>{product.stableKey ?? "-"}</td>
                      <td>{product.issueCodes.map(formatIdentifier).join(", ")}</td>
                      <td>{product.affectedAttributes.map(formatIdentifier).join(", ") || "-"}</td>
                      <td>{product.issueCount.toLocaleString("en")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {summary.truncated ? (
        <p className="detail-empty">Showing a bounded subset of products for investigation.</p>
      ) : null}
    </DetailSection>
  );
}

function SampleSection({ samples }: { samples: DashboardIncidentDetail["samples"] }) {
  const hasIssueDetails = samples.some((sample) => sample.issueCode);

  return (
    <DetailSection title="Evidence samples" description="Representative items captured when the incident was evaluated.">
      {samples.length === 0 ? (
        <EmptyDetailSection message="No evidence samples were recorded for this incident." />
      ) : (
        <div className="detail-table-scroll">
          <table className="detail-table sample-table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Stable key</th>
                <th scope="col">Offer ID</th>
                <th scope="col">URL</th>
                {hasIssueDetails ? <th scope="col">Issue</th> : null}
                {hasIssueDetails ? <th scope="col">Severity</th> : null}
                {hasIssueDetails ? <th scope="col">Attribute</th> : null}
              </tr>
            </thead>
            <tbody>
              {samples.map((sample, index) => {
                const safeUrl = safeExternalUrl(sample.url);
                return (
                  <tr key={`${sample.stableKey ?? "sample"}-${sample.offerId ?? index}`}>
                    <td>{sample.title ?? "-"}</td>
                    <td>{sample.stableKey ?? "-"}</td>
                    <td>{sample.offerId ?? "-"}</td>
                    <td>
                      {safeUrl ? (
                        <a className="external-sample-link" href={safeUrl} rel="noreferrer" target="_blank">
                          Open URL
                        </a>
                      ) : (
                        "Unavailable"
                      )}
                    </td>
                    {hasIssueDetails ? <td>{sample.issueCode ?? "-"}</td> : null}
                    {hasIssueDetails ? <td>{sample.issueSeverity ?? "-"}</td> : null}
                    {hasIssueDetails ? <td>{sample.affectedAttribute ?? "-"}</td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </DetailSection>
  );
}

function TimelineSection({ timeline }: { timeline: DashboardIncidentDetail["timeline"] }) {
  return (
    <DetailSection title="Timeline" description="Lifecycle events recorded for this incident.">
      {timeline.length === 0 ? (
        <EmptyDetailSection message="No lifecycle events have been recorded yet." />
      ) : (
        <ol className="detail-timeline">
          {timeline.map((event) => (
            <li key={event.id}>
              <div>
                <strong>{formatIdentifier(event.type)}</strong>
                <span>{statusTransitionLabel(event.fromStatus, event.toStatus)}</span>
                {event.reason ? <p>{event.reason}</p> : null}
              </div>
              <time dateTime={event.createdAt}>{formatTimestamp(event.createdAt)}</time>
            </li>
          ))}
        </ol>
      )}
    </DetailSection>
  );
}

function CommentSection({ comments }: { comments: DashboardIncidentDetail["comments"] }) {
  return (
    <DetailSection title="Comments" description="Read-only incident notes.">
      {comments.length === 0 ? (
        <EmptyDetailSection message="No comments have been added." />
      ) : (
        <ol className="detail-comments">
          {comments.map((comment) => (
            <li key={comment.id}>
              <p>{comment.body}</p>
              <time dateTime={comment.createdAt}>{formatTimestamp(comment.createdAt)}</time>
            </li>
          ))}
        </ol>
      )}
    </DetailSection>
  );
}

function AlertDeliverySection({ deliveries }: { deliveries: DashboardIncidentDetail["alertDeliveries"] }) {
  return (
    <DetailSection title="Alert delivery" description="Safe delivery status for this incident.">
      {deliveries.length === 0 ? (
        <EmptyDetailSection message="No alert deliveries have been created." />
      ) : (
        <div className="detail-table-scroll">
          <table className="detail-table delivery-table">
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Status</th>
                <th scope="col">Attempts</th>
                <th scope="col">Last error code</th>
                <th scope="col">Sent</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery, index) => (
                <tr key={`${delivery.channel}-${delivery.status}-${index}`}>
                  <td>{formatIdentifier(delivery.channel)}</td>
                  <td>{formatIdentifier(delivery.status)}</td>
                  <td>{delivery.attemptCount.toLocaleString("en")}</td>
                  <td>{delivery.lastErrorCode ?? "-"}</td>
                  <td>{delivery.sentAt ? formatTimestamp(delivery.sentAt) : "Not sent"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DetailSection>
  );
}

function DetailSection({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="detail-section">
      <div className="detail-section-heading">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {children}
    </section>
  );
}

function EmptyDetailSection({ message }: { message: string }) {
  return <p className="detail-empty">{message}</p>;
}

function formatConfidence(value: number | null): string {
  return value === null ? "Not classified" : `${Math.round(value * 100)}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? "-" : value.toLocaleString("en", { maximumFractionDigits: 2 });
}

function formatPercent(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toLocaleString("en", { maximumFractionDigits: 1 })}%`;
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
