export default function MerchantCenterLoading() {
  return (
    <main className="dashboard-shell merchant-center-shell" aria-busy="true" aria-label="Loading Merchant Center">
      <header className="dashboard-header dashboard-loading-header">
        <div>
          <span className="loading-line loading-mark" />
          <span className="loading-line loading-title" />
          <span className="loading-line loading-copy" />
        </div>
        <span className="loading-line loading-detail-back" />
      </header>
      <section className="merchant-center-overview"><span className="loading-line loading-heading" /><span className="loading-line loading-copy" /></section>
      <section className="merchant-center-sections" aria-hidden="true"><span className="loading-line loading-detail-table" /><span className="loading-line loading-detail-table" /></section>
    </main>
  );
}
