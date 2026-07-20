import {
  escapeXml,
  stagingTestCatalogProduct,
  stagingTestCatalogUrls
} from "../../lib/staging-test-catalog";

export const dynamic = "force-dynamic";

const xmlHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/xml; charset=utf-8"
};

export function GET(request: Request) {
  const { image, productPage, storefront } = stagingTestCatalogUrls(request);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>EIM staging test catalog</title>
    <link>${escapeXml(storefront)}</link>
    <description>Test-only Merchant Center fixture. No products are for purchase.</description>
    <item>
      <g:id>${stagingTestCatalogProduct.offerId}</g:id>
      <title>${escapeXml(stagingTestCatalogProduct.title)}</title>
      <description>${escapeXml(stagingTestCatalogProduct.description)}</description>
      <link>${escapeXml(productPage)}</link>
      <g:image_link>${escapeXml(image)}</g:image_link>
      <g:availability>${stagingTestCatalogProduct.availability}</g:availability>
      <g:condition>${stagingTestCatalogProduct.condition}</g:condition>
      <g:price>${stagingTestCatalogProduct.price} ${stagingTestCatalogProduct.currency}</g:price>
      <g:brand>${stagingTestCatalogProduct.brand}</g:brand>
      <g:identifier_exists>false</g:identifier_exists>
    </item>
  </channel>
</rss>`;

  return new Response(body, { headers: xmlHeaders });
}
