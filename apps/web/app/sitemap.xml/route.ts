import { escapeXml, stagingTestCatalogUrls } from "../../lib/staging-test-catalog";

export const dynamic = "force-dynamic";

const xmlHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/xml; charset=utf-8"
};

export function GET(request: Request) {
  const { productPage } = stagingTestCatalogUrls(request);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${escapeXml(productPage)}</loc>
  </url>
</urlset>`;

  return new Response(body, { headers: xmlHeaders });
}
