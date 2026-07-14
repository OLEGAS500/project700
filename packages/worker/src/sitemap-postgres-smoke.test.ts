import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { Client } = pg;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDatabase =
  testDatabaseUrl && process.env.RUN_POSTGRES_TESTS === "1" ? describe : describe.skip;
const schemaName = `eim_sitemap_${Date.now()}_${Math.random()
  .toString(16)
  .slice(2)}`;

function withSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

describeIfDatabase("sitemap postgres vertical slice", () => {
  const admin = new Client({ connectionString: testDatabaseUrl });
  let dbUrlWithSchema: string;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schemaName}`);

    dbUrlWithSchema = withSearchPath(testDatabaseUrl!, schemaName);
    process.env.DATABASE_URL = dbUrlWithSchema;

    const migration = await readFile(
      path.join(process.cwd(), "packages/db/migrations/0001_initial.sql"),
      "utf8"
    );
    const migrator = new Client({ connectionString: dbUrlWithSchema });
    await migrator.connect();
    await migrator.query(migration);
    await migrator.end();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin.end();
  });

  it("runs sitemap and feed collectors into checks, items, and snapshot counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const value = String(url);

        if (value.endsWith("sitemap.xml")) {
          return new Response(`
            <urlset>
              <url><loc>https://example.com/products/one?utm_source=x</loc></url>
              <url><loc>https://example.com/products/one</loc></url>
              <url><loc>https://example.com/products/two</loc></url>
            </urlset>
          `);
        }

        if (value.endsWith("/products.json")) {
          return new Response("not found", { status: 404 });
        }

        if (value.includes("/collections/all")) {
          return new Response(`
            <a href="/products/one?utm_source=x">One</a>
            <a href="/products/two">Two</a>
          `);
        }

        if (value.includes("/products/one") || value.includes("/products/two")) {
          const slug = value.includes("/products/one") ? "one" : "two";
          return new Response(`
            <link rel="canonical" href="https://example.com/products/${slug}" />
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "Product",
                "name": "Product ${slug}",
                "image": "https://example.com/${slug}.jpg",
                "offers": {
                  "@type": "Offer",
                  "price": "10.00",
                  "priceCurrency": "USD",
                  "availability": "https://schema.org/InStock"
                }
              }
            </script>
          `);
        }

        return new Response(`
          <rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
            <channel>
              <item>
                <g:id>SKU-1</g:id>
                <g:link>https://example.com/products/one</g:link>
              </item>
              <item>
                <g:id>SKU-2</g:id>
                <g:link>https://example.com/products/two</g:link>
              </item>
            </channel>
          </rss>
        `);
      })
    );

    const { createStore } = await import("@eim/db");
    const { runSourceSnapshotForStore } = await import("@eim/worker");

    const created = await createStore({
      name: "Sitemap Store",
      domain: "https://example.com",
      sitemapUrl: "https://example.com/sitemap.xml",
      feedUrl: "https://example.com/feed.xml",
      categoryUrls: ["https://example.com/collections/all"]
    });

    const snapshot = await runSourceSnapshotForStore(created.store.id);

    expect(snapshot.status).toBe("completed");
    expect(snapshot.sitemapUrlCount).toBe(2);
    expect(snapshot.feedProductCount).toBe(2);

    const client = new Client({ connectionString: dbUrlWithSchema });
    await client.connect();

    const sourceChecks = await client.query<{ count: string }>(
      "SELECT COUNT(*) FROM source_checks WHERE snapshot_id = $1",
      [snapshot.snapshotId]
    );
    const sitemapItems = await client.query<{ count: string }>(
      "SELECT COUNT(*) FROM source_items WHERE snapshot_id = $1 AND source = 'sitemap'",
      [snapshot.snapshotId]
    );
    const feedItems = await client.query<{ count: string }>(
      "SELECT COUNT(*) FROM source_items WHERE snapshot_id = $1 AND source = 'feed'",
      [snapshot.snapshotId]
    );
    const storefrontItems = await client.query<{ count: string }>(
      "SELECT COUNT(*) FROM source_items WHERE snapshot_id = $1 AND source = 'storefront'",
      [snapshot.snapshotId]
    );
    const enrichedStorefrontItems = await client.query<{ count: string }>(
      `
        SELECT COUNT(*)
        FROM source_items
        WHERE snapshot_id = $1
          AND source = 'storefront'
          AND http_status = 200
          AND schema_present = true
          AND price = '10.00'
      `,
      [snapshot.snapshotId]
    );
    const snapshotRow = await client.query<{
      sitemap_url_count: number;
      feed_product_count: number;
    }>(
      "SELECT sitemap_url_count, feed_product_count FROM snapshots WHERE id = $1",
      [snapshot.snapshotId]
    );

    await client.end();

    expect(Number(sourceChecks.rows[0].count)).toBe(5);
    expect(Number(sitemapItems.rows[0].count)).toBe(2);
    expect(Number(feedItems.rows[0].count)).toBe(2);
    expect(Number(storefrontItems.rows[0].count)).toBe(2);
    expect(Number(enrichedStorefrontItems.rows[0].count)).toBe(2);
    expect(snapshotRow.rows[0].sitemap_url_count).toBe(2);
    expect(snapshotRow.rows[0].feed_product_count).toBe(2);
  });
});
