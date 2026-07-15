import Link from "next/link";

export default function ThresholdsNotFound() {
  return (
    <main className="dashboard-shell thresholds-shell">
      <Link className="back-link" href="/dashboard">Stores overview</Link>
      <section className="incident-state" role="alert">
        <h1>Store not found</h1>
        <p>This store may have been removed or the link is no longer current.</p>
        <Link href="/dashboard">Back to dashboard</Link>
      </section>
    </main>
  );
}
