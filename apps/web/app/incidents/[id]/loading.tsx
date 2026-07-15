export default function IncidentDetailLoading() {
  return (
    <main className="dashboard-shell incident-detail-shell" aria-busy="true" aria-label="Loading incident detail">
      <header className="detail-header detail-loading-header">
        <span className="loading-line loading-detail-back" />
        <span className="loading-line loading-detail-store" />
        <span className="loading-line loading-detail-title" />
        <span className="loading-line loading-copy" />
      </header>
      <div className="detail-facts detail-loading-facts">
        {Array.from({ length: 6 }, (_, index) => (
          <span className="loading-line loading-detail-fact" key={index} />
        ))}
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <section className="detail-section" key={index}>
          <span className="loading-line loading-heading" />
          <span className="loading-line loading-detail-table" />
        </section>
      ))}
    </main>
  );
}
