import Link from "next/link";

export default function IncidentNotFound() {
  return (
    <main className="dashboard-shell incident-detail-shell">
      <Link className="back-link" href="/incidents">
        All incidents
      </Link>
      <section className="incident-state" role="alert">
        <h1>Incident not found</h1>
        <p>This incident may have been removed or the link is no longer current.</p>
        <Link href="/incidents">Back to incidents</Link>
      </section>
    </main>
  );
}
