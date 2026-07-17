import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Return policy | Ecommerce Incident Monitor",
  description: "Return policy for the Ecommerce Incident Monitor staging test storefront."
};

export default function ReturnPolicyPage() {
  return (
    <main className="legal-shell">
      <header className="legal-header">
        <Link className="product-mark" href="/">
          EIM
        </Link>
        <Link className="back-link" href="/">
          Back to the staging storefront
        </Link>
      </header>

      <article className="legal-policy">
        <p className="section-label">Staging test storefront</p>
        <h1>Return policy</h1>
        <p className="legal-policy-intro">
          This policy applies only to the Ecommerce Incident Monitor staging storefront used for
          Merchant Center integration testing. No real products, payments, or customer orders are
          offered through this site.
        </p>

        <section>
          <h2>Return window</h2>
          <p>
            If a test order is created during an integration check, its test item may be returned
            within 30 calendar days of delivery.
          </p>
        </section>

        <section>
          <h2>Return cost and refund</h2>
          <p>
            Test returns are free. No physical merchandise is shipped and no customer payment is
            collected, so a test return does not create a financial refund.
          </p>
        </section>

        <section>
          <h2>How to request a test return</h2>
          <p>
            Submit the request through the same staging test workflow that created the order and
            include the test order and item identifiers. The staging-store administrator will
            confirm the test return in that workflow.
          </p>
        </section>
      </article>
    </main>
  );
}
