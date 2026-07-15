export default function IncidentsLoading() {
  return (
    <main className="dashboard-shell incident-list-shell" aria-busy="true" aria-label="Loading incidents">
      <header className="dashboard-header dashboard-loading-header">
        <div>
          <span className="loading-line loading-mark" />
          <span className="loading-line loading-title" />
          <span className="loading-line loading-copy" />
        </div>
      </header>
      <section className="incident-filter-loading">
        {Array.from({ length: 5 }, (_, index) => (
          <span className="loading-line loading-filter" key={index} />
        ))}
      </section>
      <section className="dashboard-table-region">
        <div className="dashboard-table-heading">
          <span className="loading-line loading-heading" />
        </div>
        <div className="dashboard-loading-rows">
          {Array.from({ length: 6 }, (_, index) => (
            <span className="loading-line loading-row" key={index} />
          ))}
        </div>
      </section>
    </main>
  );
}
