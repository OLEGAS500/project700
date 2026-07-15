export default function DestinationsLoading() {
  return (
    <main className="dashboard-shell destinations-shell" aria-busy="true" aria-label="Loading alert destinations">
      <header className="dashboard-header dashboard-loading-header">
        <div>
          <span className="loading-line loading-mark" />
          <span className="loading-line loading-title" />
          <span className="loading-line loading-copy" />
        </div>
        <span className="loading-line loading-detail-back" />
      </header>
      <section className="destinations-intro">
        <span className="loading-line loading-heading" />
        <span className="loading-line loading-copy" />
      </section>
      <section className="destinations-grid" aria-hidden="true">
        <span className="loading-line loading-detail-table" />
        <span className="loading-line loading-detail-table" />
      </section>
    </main>
  );
}
