import { getAlertPreferences, getStore } from "@eim/db";
import type { AlertPreferencesRecord, StoreSummary } from "@eim/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import AlertPreferencesForm from "./alert-preferences-form";

export const dynamic = "force-dynamic";

export default async function AlertPreferencesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let store: StoreSummary | null;

  try {
    store = await getStore(id);
  } catch {
    return <AlertPreferencesState />;
  }

  if (!store) notFound();

  let record: AlertPreferencesRecord;
  try {
    record = await getAlertPreferences(id);
  } catch {
    return <AlertPreferencesState />;
  }

  return (
    <main className="dashboard-shell alert-preferences-shell">
      <header className="dashboard-header">
        <div>
          <Link className="product-mark" href="/dashboard">EIM</Link>
          <h1>Alert preferences</h1>
          <p>{store.name} <span className="alert-preferences-domain">{store.domain}</span></p>
        </div>
        <Link className="back-link" href="/dashboard">Stores overview</Link>
      </header>

      <section className="alert-preferences-intro">
        <div>
          <h2>Notification controls</h2>
          <p>Choose which alert channels and incident lifecycle events this store should deliver.</p>
        </div>
        <span>Preference version {record.alertPreferenceVersion} · updated {formatTimestamp(record.updatedAt)}</span>
      </section>

      <AlertPreferencesForm storeId={id} record={record} />
    </main>
  );
}

function AlertPreferencesState() {
  return (
    <main className="dashboard-shell alert-preferences-shell">
      <Link className="back-link" href="/dashboard">Stores overview</Link>
      <section className="incident-state incident-state-failure" role="alert">
        <h1>Alert preferences are unavailable</h1>
        <p>The store alert preferences could not be read right now. Try again later.</p>
        <Link href="/dashboard">Back to dashboard</Link>
      </section>
    </main>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
