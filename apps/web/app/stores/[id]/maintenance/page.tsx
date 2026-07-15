import { getStore, listMaintenanceWindows } from "@eim/db";
import type { MaintenanceWindowRecord } from "@eim/db";
import type { StoreSummary } from "@eim/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import CreateMaintenanceForm from "./create-maintenance-form";
import MaintenanceWindowList from "./maintenance-window-list";

export const dynamic = "force-dynamic";

export default async function MaintenancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let store: StoreSummary | null;

  try {
    store = await getStore(id);
  } catch {
    return <MaintenanceState />;
  }

  if (!store) notFound();

  let windows: MaintenanceWindowRecord[];
  try {
    windows = await listMaintenanceWindows(id);
  } catch {
    return <MaintenanceState />;
  }

  return (
    <main className="dashboard-shell maintenance-shell">
      <header className="dashboard-header">
        <div><Link className="product-mark" href="/dashboard">EIM</Link><h1>Maintenance</h1><p>{store.name} <span className="maintenance-domain">{store.domain}</span></p></div>
        <Link className="back-link" href="/dashboard">Stores overview</Link>
      </header>
      <section className="maintenance-create-section"><div className="detail-section-heading"><div><h2>New maintenance window</h2><p>Alerts continue to be recorded while delivery is suppressed.</p></div></div><CreateMaintenanceForm storeId={id} /></section>
      <MaintenanceWindowList storeId={id} windows={windows} />
    </main>
  );
}

function MaintenanceState() {
  return <main className="dashboard-shell maintenance-shell"><Link className="back-link" href="/dashboard">Stores overview</Link><section className="incident-state incident-state-failure" role="alert"><h1>Maintenance data is unavailable</h1><p>The maintenance windows could not be read right now. Try again later.</p><Link href="/dashboard">Back to dashboard</Link></section></main>;
}
