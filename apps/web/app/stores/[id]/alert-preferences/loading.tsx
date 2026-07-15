export default function AlertPreferencesLoading() {
  return (
    <main className="dashboard-shell alert-preferences-shell" aria-busy="true" aria-label="Loading alert preferences">
      <header className="dashboard-header dashboard-loading-header">
        <div>
          <span className="loading-line loading-mark" />
          <span className="loading-line loading-title" />
          <span className="loading-line loading-copy" />
        </div>
        <span className="loading-line loading-detail-back" />
      </header>
      <section className="alert-preferences-intro">
        <span className="loading-line loading-heading" />
        <span className="loading-line loading-copy" />
      </section>
      <section className="alert-preferences-form" aria-hidden="true">
        <span className="loading-line loading-detail-table" />
        <span className="loading-line loading-detail-table" />
        <span className="loading-line loading-detail-table" />
      </section>
    </main>
  );
}
