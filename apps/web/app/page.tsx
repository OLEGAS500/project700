import { listBaselineMetrics, listStores } from "@eim/db";
import type { BaselineMetricRecord, StoreSummary } from "@eim/db";
import { StoreCreateForm } from "./store-create-form";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let stores: StoreSummary[] = [];
  let baselinesByStore = new Map<string, BaselineMetricRecord[]>();
  let databaseError: string | null = null;

  try {
    stores = await listStores();
    baselinesByStore = new Map(
      await Promise.all(
        stores.map(async (store) => [store.id, await listBaselineMetrics(store.id)] as const)
      )
    );
  } catch (error) {
    databaseError =
      error instanceof Error ? error.message : "Unable to load stores from database";
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="section-label">Milestone 1</p>
          <h1>Revenue incident monitoring for ecommerce stores.</h1>
          <p className="hero-copy">
            Add a store, keep it in baseline learning, and queue the first snapshot
            before any incident engine starts making claims.
          </p>
        </div>
        <div className="status-panel">
          <span className="status-dot" />
          <div>
            <strong>Core flow</strong>
            <p>Store creation &rarr; learning baseline &rarr; queued snapshot</p>
          </div>
        </div>
      </section>

      {databaseError ? (
        <section className="notice">
          <h2>Database connection needed</h2>
          <p>
            Set <code>DATABASE_URL</code> and apply the migration at{" "}
            <code>packages/db/migrations/0001_initial.sql</code> to use the UI.
          </p>
          <p className="muted">{databaseError}</p>
        </section>
      ) : null}

      <section className="grid">
        <StoreCreateForm disabled={Boolean(databaseError)} />

        <div className="panel">
          <div className="panel-header">
            <div>
              <p className="section-label">Stores</p>
              <h2>Monitored stores</h2>
            </div>
            <span className="count">{stores.length}</span>
          </div>

          {stores.length === 0 ? (
            <div className="empty-state">
              <h3>No stores yet</h3>
              <p>Create the first store to queue a baseline candidate snapshot.</p>
            </div>
          ) : (
            <div className="store-list">
              {stores.map((store) => (
                <article className="store-row" key={store.id}>
                  <div>
                    <h3>{store.name}</h3>
                    <p>{store.domain}</p>
                    {(baselinesByStore.get(store.id) ?? []).map((baseline) => (
                      <p className="baseline-line" key={baseline.id}>
                        {baseline.source}.{baseline.metric}: {baseline.status},{" "}
                        {baseline.sampleCount} samples, median {baseline.medianValue}
                      </p>
                    ))}
                  </div>
                  <div className="store-meta">
                    <span>{store.baselineStatus}</span>
                    <span>{store.latestSnapshotStatus ?? "no snapshot"}</span>
                    <span>{store.categoryCount} categories</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
