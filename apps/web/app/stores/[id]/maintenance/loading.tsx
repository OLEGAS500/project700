export default function MaintenanceLoading() {
  return (
    <main className="dashboard-shell maintenance-shell" aria-busy="true" aria-label="Loading maintenance windows">
      <header className="dashboard-header dashboard-loading-header">
        <div>
          <span className="loading-line loading-mark" />
          <span className="loading-line loading-title" />
          <span className="loading-line loading-copy" />
        </div>
        <span className="loading-line loading-detail-back" />
      </header>
      <section className="maintenance-create-section">
        <span className="loading-line loading-heading" />
        <span className="loading-line loading-detail-table" />
      </section>
      <section className="maintenance-list-section">
        <span className="loading-line loading-heading" />
        <span className="loading-line loading-detail-table" />
      </section>
    </main>
  );
}
