import {
  getEmailDestination,
  getStore,
  getTelegramDestination
} from "@eim/db";
import type {
  EmailDestinationRecord,
  StoreSummary,
  TelegramDestinationRecord
} from "@eim/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmailDestinationForm, TelegramDestinationForm } from "./destination-forms";

export const dynamic = "force-dynamic";

export default async function DestinationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let store: StoreSummary | null;

  try {
    store = await getStore(id);
  } catch {
    return <DestinationsState />;
  }

  if (!store) notFound();

  let emailDestination: EmailDestinationRecord | null;
  let telegramDestination: TelegramDestinationRecord | null;
  try {
    [emailDestination, telegramDestination] = await Promise.all([
      getEmailDestination(id),
      getTelegramDestination(id)
    ]);
  } catch {
    return <DestinationsState />;
  }

  return (
    <main className="dashboard-shell destinations-shell">
      <header className="dashboard-header">
        <div>
          <Link className="product-mark" href="/dashboard">EIM</Link>
          <h1>Alert destinations</h1>
          <p>{store.name} <span className="destinations-domain">{store.domain}</span></p>
        </div>
        <Link className="back-link" href="/dashboard">Stores overview</Link>
      </header>

      <section className="destinations-intro">
        <h2>Where alerts are delivered</h2>
        <p>Configure the addresses used by eligible delivery intents. Provider credentials are kept outside the store settings.</p>
      </section>

      <section className="destinations-grid" aria-label="Alert destination settings">
        <section className="destination-section">
          <div className="detail-section-heading">
            <div><h2>Email</h2><p>Send alerts to a small operational recipient list.</p></div>
          </div>
          <EmailDestinationForm storeId={id} destination={emailDestination} />
        </section>
        <section className="destination-section">
          <div className="detail-section-heading">
            <div><h2>Telegram</h2><p>Send alerts to a chat or optional topic thread.</p></div>
          </div>
          <TelegramDestinationForm storeId={id} destination={telegramDestination} />
        </section>
      </section>
    </main>
  );
}

function DestinationsState() {
  return (
    <main className="dashboard-shell destinations-shell">
      <Link className="back-link" href="/dashboard">Stores overview</Link>
      <section className="incident-state incident-state-failure" role="alert">
        <h1>Alert destinations are unavailable</h1>
        <p>The store destinations could not be read right now. Try again later.</p>
        <Link href="/dashboard">Back to dashboard</Link>
      </section>
    </main>
  );
}
