import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "EIM Catalog Monitor Test Item | Ecommerce Incident Monitor",
  description:
    "A catalog-only test item used for Ecommerce Incident Monitor Merchant Center integration checks."
};

export default function EimCatalogMonitorTestItemPage() {
  return (
    <main className="test-product-shell">
      <header className="test-product-header">
        <Link className="product-mark" href="/">
          EIM
        </Link>
        <Link className="back-link" href="/return-policy">
          View return policy
        </Link>
      </header>

      <article className="test-product-card">
        <div className="test-product-image-wrap">
          <Image
            alt="EIM Catalog Monitor test item illustration"
            className="test-product-image"
            height={1000}
            src="/test-products/eim-catalog-monitor/opengraph-image"
            unoptimized
            width={1000}
          />
          <span className="test-product-badge">Test-only item</span>
        </div>

        <div className="test-product-details">
          <p className="section-label">Staging test storefront</p>
          <h1>EIM Catalog Monitor Test Item</h1>
          <p className="test-product-price">$1.00 USD</p>
          <p className="test-product-summary">
            A catalog-only item used to check the Ecommerce Incident Monitor Merchant Center
            integration. It has no real inventory, fulfilment, payment, or purchase flow.
          </p>

          <dl className="test-product-specs">
            <div>
              <dt>Availability</dt>
              <dd>Out of stock — not for purchase</dd>
            </div>
            <div>
              <dt>Condition</dt>
              <dd>New</dd>
            </div>
            <div>
              <dt>SKU</dt>
              <dd>EIM-STAGING-TEST-001</dd>
            </div>
          </dl>

          <section className="test-product-notice" aria-label="Test item notice">
            <h2>Test environment notice</h2>
            <p>
              This page exists solely for provider integration checks. Do not attempt to purchase
              this item: no order will be created and no money is collected.
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}
