import { getStore, getStoreThresholds } from "@eim/db";
import type { StoreSummary, StoreThresholdRecord } from "@eim/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import ThresholdsForm from "./thresholds-form";

export const dynamic = "force-dynamic";

export default async function ThresholdsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let store: StoreSummary | null;

  try {
    store = await getStore(id);
  } catch {
    return <ThresholdsState />;
  }

  if (!store) notFound();

  let record: StoreThresholdRecord;
  try {
    record = await getStoreThresholds(id);
  } catch {
    return <ThresholdsState />;
  }

  return (
    <main className="dashboard-shell thresholds-shell">
      <header className="dashboard-header">
        <div>
          <Link className="product-mark" href="/dashboard">EIM</Link>
          <h1>Thresholds</h1>
          <p>{store.name} <span className="thresholds-domain">{store.domain}</span></p>
        </div>
        <Link className="back-link" href="/dashboard">Stores overview</Link>
      </header>
      <section className="thresholds-intro">
        <h2>Store monitoring thresholds</h2>
        <p>These values apply to future checks. Existing incidents keep their captured configuration.</p>
      </section>
      <ThresholdsForm storeId={id} thresholds={record.thresholds} />
    </main>
  );
}

function ThresholdsState() {
  return (
    <main className="dashboard-shell thresholds-shell">
      <Link className="back-link" href="/dashboard">Stores overview</Link>
      <section className="incident-state incident-state-failure" role="alert">
        <h1>Threshold data is unavailable</h1>
        <p>The store thresholds could not be read right now. Try again later.</p>
        <Link href="/dashboard">Back to dashboard</Link>
      </section>
    </main>
  );
}
