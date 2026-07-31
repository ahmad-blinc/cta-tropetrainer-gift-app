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
};

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
    const pdf = await page.pdf({ format: "Letter", printBackground: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// Matches Chant Torah America's official certificate design (client-provided
// PDF): plain white Letter page, seal + arched banner, recipient name on a
// fillable line, blank "scheduled dates" lines (intentionally left blank —
// filled in by hand, not part of the order data), an activation code box,
// and the TropeTrainer / Cantors Assembly logos anchored at the bottom.
export const DEFAULT_CERTIFICATE_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; }

  .cta-certificate {
    width: 100%;
    min-height: 1056px;
    padding: 70px 80px 50px;
    background: #ffffff;
    color: #1a1a1a;
    font-family: Arial, Helvetica, sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .cta-seal {
    width: 100%;
    max-width: 460px;
    height: auto;
    display: block;
  }

  .cta-intro {
    margin-top: 30px;
    text-align: center;
    font-size: 17px;
    line-height: 1.55;
  }

  .cta-recipient-line {
    margin-top: 32px;
    width: 100%;
    max-width: 600px;
    border-bottom: 1.5px solid #1a1a1a;
    padding-bottom: 8px;
    text-align: center;
    font-size: 24px;
    font-weight: 600;
    min-height: 32px;
  }

  .cta-section-label {
    margin-top: 34px;
    text-align: center;
    font-size: 15px;
  }

  .cta-dates-grid {
    margin-top: 20px;
    width: 100%;
    max-width: 560px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 26px 44px;
  }

  .cta-dates-grid div {
    border-bottom: 1px solid #1a1a1a;
    height: 4px;
  }

  .cta-code-box {
    margin-top: 16px;
    border: 1px solid #8b8b8b;
    padding: 14px 30px;
    min-width: 260px;
    text-align: center;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 1px;
  }

  .cta-footer-logos {
    margin-top: auto;
    padding-top: 50px;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .cta-footer-logos img {
    height: 44px;
    width: auto;
    max-width: 220px;
    object-fit: contain;
  }
</style>
</head>
<body>
  <div class="cta-certificate">
    <img class="cta-seal" src="{{sealImageUrl}}" alt="Chant Torah America" />

    <div class="cta-intro">
      In honor of your Simcha,<br />
      a One-Year Subscription to TropeTrainer<br />
      is presented to:
    </div>

    <div class="cta-recipient-line">{{recipientName}}</div>

    <div class="cta-section-label">You are scheduled to Chant Torah on the following dates:</div>
    <div class="cta-dates-grid">
      <div></div>
      <div></div>
      <div></div>
      <div></div>
    </div>

    <div class="cta-section-label">Go to tropetrainer.com/activate to get started:</div>
    <div class="cta-code-box">{{activationCode}}</div>

    <div class="cta-footer-logos">
      <img src="{{tropetrainerLogoUrl}}" alt="TropeTrainer" />
      <img src="{{cantorsLogoUrl}}" alt="Cantors Assembly" />
    </div>
  </div>
</body>
</html>`;
