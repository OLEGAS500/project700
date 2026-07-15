export default function ThresholdsLoading() {
  return (
    <main className="dashboard-shell thresholds-shell" aria-busy="true" aria-label="Loading thresholds">
      <header className="dashboard-header dashboard-loading-header">
        <div>
          <span className="loading-line loading-mark" />
          <span className="loading-line loading-title" />
          <span className="loading-line loading-copy" />
        </div>
        <span className="loading-line loading-detail-back" />
      </header>
      <section className="thresholds-intro">
        <span className="loading-line loading-heading" />
        <span className="loading-line loading-copy" />
      </section>
      <span className="loading-line loading-detail-table" />
    </main>
  );
}
