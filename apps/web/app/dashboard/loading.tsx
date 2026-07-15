export default function DashboardLoading() {
  return (
    <main className="dashboard-shell" aria-busy="true" aria-label="Loading stores overview">
      <header className="dashboard-header dashboard-loading-header">
        <div>
          <span className="loading-line loading-mark" />
          <span className="loading-line loading-title" />
          <span className="loading-line loading-copy" />
        </div>
      </header>
      <div className="dashboard-summary dashboard-loading-summary">
        {Array.from({ length: 4 }, (_, index) => (
          <span className="loading-line loading-metric" key={index} />
        ))}
      </div>
      <section className="dashboard-table-region">
        <div className="dashboard-table-heading">
          <span className="loading-line loading-heading" />
        </div>
        <div className="dashboard-loading-rows">
          {Array.from({ length: 5 }, (_, index) => (
            <span className="loading-line loading-row" key={index} />
          ))}
        </div>
      </section>
    </main>
  );
}
