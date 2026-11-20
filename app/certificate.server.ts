import crypto from "crypto";
import Mustache from "mustache";
import puppeteer from "puppeteer";
import { unauthenticated } from "./shopify.server";
import db from "./db.server";
import type { AdminClient } from "./gift-order.server";
import { getCertificateAssetUrls, getDefaultAssetUrl } from "./certificate-assets.server";

export const CERTIFICATE_METAFIELD_NAMESPACE = "custom";
export const CERTIFICATE_METAFIELD_KEY = "certificate_url";

function getSigningSecret(): string {
  return process.env.CERTIFICATE_SECRET || process.env.SHOPIFY_API_SECRET || "";
}

export function signOrderId(orderId: string): string {
  return crypto.createHmac("sha256", getSigningSecret()).update(orderId).digest("hex");
}

export function isValidCertificateToken(orderId: string, token: string): boolean {
  const expected = signOrderId(orderId);
  const expectedBuf = Buffer.from(expected);
  const tokenBuf = Buffer.from(token);
  if (expectedBuf.length !== tokenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, tokenBuf);
}

export function buildCertificateUrl(orderId: string): string {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  const token = signOrderId(orderId);
  return `${base}/certificate/${orderId}?token=${token}`;
}

// A per-shop (not per-order) key, deterministic from the shop domain — no DB
// write needed, so it's usable directly inside Shopify's notification Liquid
// as a literal value baked into the snippet at generation time. This is what
// lets the certificate link in the order confirmation email be built entirely
// from {{ order.id }} (which Liquid already has instantly, no webhook
// involved) instead of a metafield our webhook writes asynchronously —
// eliminating the race between our webhook and Shopify's near-instant email
// send. Same tradeoff Order Printer Pro uses: knowing this key plus any order
// id for the shop is enough to view that order's certificate, so it's weaker
// than the per-order signed token above, which stays in use for the
// certificate_url metafield / the app's own "View certificate PDF" button.
export function getShopCertificateKey(shop: string): string {
  return crypto.createHmac("sha256", getSigningSecret()).update(shop).digest("hex").slice(0, 32);
}

export function isValidShopCertificateKey(shop: string, key: string): boolean {
  const expected = getShopCertificateKey(shop);
  const expectedBuf = Buffer.from(expected);
  const keyBuf = Buffer.from(key);
  if (expectedBuf.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, keyBuf);
}

// Pieces needed to build the Liquid-embedded instant certificate link — kept
// separate (rather than a finished URL) since the order id segment has to
// stay literal Liquid syntax ({{ order.id }}) for Shopify to fill in at
// email-render time, not a real value we can compute ahead of time.
export function getInstantCertificateLinkParts(shop: string): {
  appUrl: string;
  shop: string;
  key: string;
} {
  return {
    appUrl: (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, ""),
    shop,
    key: getShopCertificateKey(shop),
  };
}

// Saves the (already-signed) certificate link to an order metafield as soon as
// a gift order is detected — independent of whether the TropeTrainer call has
// finished yet, since the certificate route itself generates the PDF on demand
// with whatever code is available at click time. This is what removes the
// order-confirmation-email race condition: the link is ready almost instantly,
// well before the email actually goes out.
export async function saveCertificateUrlMetafield(
  admin: AdminClient,
  orderGid: string,
  shopifyOrderId: string,
): Promise<void> {
  await admin.graphql(
    `#graphql
    mutation SetCertificateUrl($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: orderGid,
            namespace: CERTIFICATE_METAFIELD_NAMESPACE,
            key: CERTIFICATE_METAFIELD_KEY,
            type: "url",
            value: buildCertificateUrl(shopifyOrderId),
          },
        ],
      },
    },
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type CertificateData = {
  recipientName: string;
  giverName: string;
  activationCode: string;
  shopName: string;
  shopLogoUrl: string | null;
  formattedDate: string;
  initial: string;
  sealImageUrl: string;
  tropetrainerLogoUrl: string;
  cantorsLogoUrl: string;
  rulesImageUrl: string;
};

// The name line, scheduled-date lines and code box, cropped pixel-for-pixel
// from the client's own 300 DPI certificate artwork so they look identical to
// their design in every viewer and on paper. Not a merchant brand asset.
function getRulesImageUrl(): string {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  return `${base}/certificate-assets/rules-default.png`;
}

export const SAMPLE_CERTIFICATE_DATA: CertificateData = {
  recipientName: "Jordan Rivera",
  giverName: "The Cohen Family",
  activationCode: "7K3M-R9PD-X2QH",
  shopName: "Chant Torah America",
  shopLogoUrl: null,
  formattedDate: "January 1, 2026",
  initial: "C",
  sealImageUrl: getDefaultAssetUrl("seal"),
  tropetrainerLogoUrl: getDefaultAssetUrl("tropetrainerLogo"),
  cantorsLogoUrl: getDefaultAssetUrl("cantorsLogo"),
  rulesImageUrl: getRulesImageUrl(),
};

export const CERTIFICATE_VARIABLES: { key: keyof CertificateData; description: string }[] = [
  { key: "recipientName", description: "The gift recipient's name" },
  { key: "activationCode", description: "The TropeTrainer activation code" },
  { key: "sealImageUrl", description: "The Chant Torah America seal image (set under Brand assets)" },
  { key: "tropetrainerLogoUrl", description: "The TropeTrainer logo image (set under Brand assets)" },
  { key: "cantorsLogoUrl", description: "The Cantors Assembly partnership badge image (set under Brand assets)" },
  { key: "giverName", description: "The gift giver's name" },
  { key: "shopName", description: "The store's name" },
  { key: "shopLogoUrl", description: "The store's logo URL, if one is set (use with #shopLogoUrl / ^shopLogoUrl sections)" },
  { key: "formattedDate", description: "The order date, formatted (e.g. January 1, 2026)" },
  { key: "initial", description: "The store name's first letter, uppercased" },
  { key: "rulesImageUrl", description: "The name line, date lines and code box artwork from the certificate design" },
];

export async function getCertificateTemplate(shop: string): Promise<string> {
  const record = await db.certificateTemplate.findUnique({ where: { shop } });
  return record?.html ?? DEFAULT_CERTIFICATE_TEMPLATE;
}

export async function saveCertificateTemplate(shop: string, html: string): Promise<void> {
  await db.certificateTemplate.upsert({
    where: { shop },
    create: { shop, html },
    update: { html },
  });
}

export async function resetCertificateTemplate(shop: string): Promise<void> {
  await db.certificateTemplate.deleteMany({ where: { shop } });
}

export function renderCertificateHtml(template: string, data: CertificateData): string {
  return Mustache.render(template, data);
}

// Used to personalize the "certificate not ready yet" waiting page with a
// first name. This link is opened from the order confirmation email, which
// Shopify sends to whoever completed checkout — the gift *giver* — not the
// recipient, so it greets them by the giver's name, not the recipient's.
// Best-effort only — the waiting page must never break because of this, so
// any failure just means no greeting is shown.
export async function getGiverFirstName(
  shop: string,
  shopifyOrderId: string,
): Promise<string | null> {
  try {
    const { admin } = await unauthenticated.admin(shop);
    const resp = await admin.graphql(
      `#graphql
      query CertificateGiverName($id: ID!) {
        order(id: $id) {
          lineItems(first: 10) {
            edges { node { customAttributes { key value } } }
          }
        }
      }`,
      { variables: { id: `gid://shopify/Order/${shopifyOrderId}` } },
    );
    const respJson = await resp.json();
    const attrs: { key: string; value: string }[] =
      respJson.data?.order?.lineItems?.edges?.flatMap(
        (e: { node: { customAttributes: { key: string; value: string }[] } }) =>
          e.node.customAttributes,
      ) ?? [];
    const giverName = attrs.find((a) => a.key.toLowerCase() === "gift giver name")?.value;
    return giverName?.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

export async function generateCertificatePdf(
  shop: string,
  shopifyOrderId: string,
): Promise<Buffer | null> {
  const { admin } = await unauthenticated.admin(shop);

  const orderResp = await admin.graphql(
    `#graphql
    query CertificateOrder($id: ID!) {
      order(id: $id) {
        createdAt
        metafield(namespace: "custom", key: "tropetrainer_code") { value }
        lineItems(first: 10) {
          edges { node { customAttributes { key value } } }
        }
      }
      shop {
        name
      }
    }`,
    { variables: { id: `gid://shopify/Order/${shopifyOrderId}` } },
  );
  const orderJson = await orderResp.json();
  const order = orderJson.data?.order;
  if (!order) return null;

  const shopName: string = orderJson.data?.shop?.name ?? shop;

  // Shop logo is a "nice to have" — fetched separately so a schema mismatch or
  // missing brand asset can never break certificate generation.
  let shopLogoUrl: string | null = null;
  try {
    const brandResp = await admin.graphql(
      `#graphql
      query CertificateShopBrand {
        shop {
          brand {
            logo { image { url } }
          }
        }
      }`,
    );
    const brandJson = await brandResp.json();
    shopLogoUrl = brandJson.data?.shop?.brand?.logo?.image?.url ?? null;
  } catch {
    shopLogoUrl = null;
  }

  const attrs: { key: string; value: string }[] = order.lineItems.edges.flatMap(
    (e: { node: { customAttributes: { key: string; value: string }[] } }) => e.node.customAttributes,
  );
  const recipientName =
    attrs.find((a) => a.key.toLowerCase() === "recipient name")?.value ?? "";
  const giverName =
    attrs.find((a) => a.key.toLowerCase() === "gift giver name")?.value ?? "";
  const activationCode: string = order.metafield?.value ?? "";
  const formattedDate = new Date(order.createdAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const assetUrls = await getCertificateAssetUrls(shop);

  const data: CertificateData = {
    recipientName: escapeHtml(recipientName) || "Recipient Name",
    giverName: escapeHtml(giverName) || "Gift Giver",
    activationCode: escapeHtml(activationCode) || "TT-XXXX-XXXX",
    shopName: escapeHtml(shopName),
    shopLogoUrl,
    formattedDate,
    initial: shopName.slice(0, 1).toUpperCase(),
    sealImageUrl: assetUrls.seal,
    tropetrainerLogoUrl: assetUrls.tropetrainerLogo,
    cantorsLogoUrl: assetUrls.cantorsLogo,
    rulesImageUrl: getRulesImageUrl(),
  };

  const template = await getCertificateTemplate(shop);
  const html = renderCertificateHtml(template, data);

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    // Google Fonts load async; wait for them explicitly so the PDF doesn't
    // fall back to system fonts.
    await page.evaluateHandle("document.fonts.ready");
    // preferCSSPageSize: the template's @page size wins (the default template
    // uses the client's exact certificate size); templates without one fall
    // back to Letter.
    const pdf = await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// Matches Chant Torah America's updated certificate design (client-provided
// PDF, Nov 2026) 1:1 — every element is placed at the exact point position
// measured from that PDF, on the same page size (474.96 × 733.92pt), so the
// spacing can't drift. The page size is set with @page and honored via
// preferCSSPageSize; the printer's "Fit to page" handles the paper choice.
//
// Font: real Times New Roman (installed in the Docker image via Microsoft's core
// fonts — see Dockerfile) so the weight and letter shapes match the client's
// PDF. Tinos (metric-compatible, same widths) is only a fallback.
//
// Data values are already HTML-escaped in generateCertificatePdf, so they're
// rendered with triple braces to avoid double-escaping (e.g. "&" → "&amp;amp;").
// Scheduled-date lines stay blank — they're filled in by hand.
export const DEFAULT_CERTIFICATE_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>TropeTrainer Gift Certificate</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Tinos:wght@400;700&display=block" rel="stylesheet" />
<style>
  @page { size: 474.96pt 733.92pt; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 474.96pt; height: 733.4pt; overflow: hidden; }

  /* A hair under the @page height: content exactly equal to the page height
     makes Chrome spill a blank second page from rounding. */
  .cta-page {
    position: relative;
    width: 474.96pt;
    height: 733.4pt;
    page-break-after: avoid;
    break-after: avoid;
    overflow: hidden;
    background: #ffffff;
    color: #000000;
    font-family: "Times New Roman", "Tinos", Times, serif;
  }

  .cta-abs { position: absolute; }
  .cta-text {
    position: absolute;
    left: 0;
    width: 100%;
    text-align: center;
    white-space: nowrap;
  }
  .cta-img { position: absolute; display: block; object-fit: contain; }
  /* Name line, date lines and code box: the client's own 300 DPI artwork
     (pixel-exact crop), 290.64 x 170.4pt at (91.92, 456.72)pt. Placed with a
     transform for the same reason as the seal below. */
  .cta-rules { left: 0; top: 0; width: 387px; height: 227px; transform-origin: 0 0;
    transform: translate(122.56px, 608.96px) scale(1.001343669, 1.000881057); }

  /* The seal and TropeTrainer logo are the client's own 300 DPI artwork; they're
     placed with transforms because Chrome snaps plain left/top/width/height to
     whole CSS pixels, which would stretch them a fraction and resample (soften)
     every pixel. Net result: exactly 300 DPI at the client's exact positions.
     seal: 436.56 x 302.64pt at (17.28, 44.4)pt */
  .cta-seal { left: 0; top: 0; width: 582px; height: 403px; transform-origin: 0 0;
    transform: translate(23.04px, 59.2px) scale(1.000137457, 1.001290323); }

  .cta-t1 { left: -0.24pt; top: 362.68pt; font-size: 15.12pt; line-height: 19.9pt; transform: translate(0.12pt, -0.36pt); }
  .cta-t2 { left: -0.24pt; top: 381.92pt; font-size: 18pt;    line-height: 23.7pt; transform: translate(0.12pt, 0.24pt); }
  .cta-t3 { top: 402.46pt; font-size: 15.12pt; line-height: 19.8pt; transform: translate(-0.12pt, -0.36pt); }

  .cta-name {
    position: absolute;
    left: 92.9pt;
    width: 288.5pt;
    top: 432pt;
    height: 24pt;
    line-height: 24pt;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    font-size: 18pt;
    font-weight: 700;
  }

  .cta-t4 { top: 486.54pt; font-size: 12pt; line-height: 15.8pt; }

  .cta-t5 { top: 576.5pt; font-size: 12pt; line-height: 15.8pt; transform: translate(0pt, -0.24pt); }
  .cta-code-box {
    position: absolute;
    left: 154.96pt;
    top: 597.87pt;
    width: 165.21pt;
    height: 27.65pt;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14pt;
    font-weight: 700;
    letter-spacing: 1pt;
    white-space: nowrap;
  }
  .cta-t6 { left: 0.24pt; top: 632.56pt; font-size: 12pt; line-height: 15.7pt; transform: translate(0.12pt, -0.12pt); }

  /* TropeTrainer logo: 176.4 x 42pt at (29.52, 665.28)pt */
  .cta-logo-tt { left: 0; top: 0; width: 235px; height: 56px; transform-origin: 0 0;
    transform: translate(39.36px, 887.04px) scale(1.000851064, 1); }
  /* Cantors Assembly logo: 172.8 x 43.44pt at (272.64, 664.8)pt */
  .cta-logo-cantors { left: 0; top: 0; width: 230px; height: 58px; transform-origin: 0 0;
    transform: translate(363.52px, 886.4px) scale(1.00173913, 0.99862069); }
</style>
</head>
<body>
  <div class="cta-page">
    <img class="cta-img cta-rules" src="{{rulesImageUrl}}" alt="" />
    <img class="cta-img cta-seal" src="{{sealImageUrl}}" alt="Chant Torah America" />

    <div class="cta-text cta-t1">In honor of your Simcha,</div>
    <div class="cta-text cta-t2">a One-Year Subscription to TropeTrainer</div>
    <div class="cta-text cta-t3">is presented to:</div>

    <div class="cta-name" id="cta-name">{{{recipientName}}}</div>

    <div class="cta-text cta-t4">You are scheduled to chant Torah on the following dates:</div>

    <div class="cta-text cta-t5">Insert the code below upon subscribing:</div>
    <div class="cta-code-box">{{{activationCode}}}</div>
    <div class="cta-text cta-t6">Go to <b>tropetrainer.com/activate</b> to get started</div>

    <img class="cta-img cta-logo-tt" src="{{tropetrainerLogoUrl}}" alt="TropeTrainer" />
    <img class="cta-img cta-logo-cantors" src="{{cantorsLogoUrl}}" alt="Cantors Assembly" />
  </div>
  <script>
    // Shrink long recipient names so they always fit on the line.
    (function () {
      function fit() {
        var el = document.getElementById("cta-name");
        if (!el) return;
        var size = 18;
        el.style.fontSize = size + "pt";
        while (el.scrollWidth > el.clientWidth && size > 9) {
          size -= 0.5;
          el.style.fontSize = size + "pt";
        }
      }
      fit();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    })();
  </script>
</body>
</html>`;
