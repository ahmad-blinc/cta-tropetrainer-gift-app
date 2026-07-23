import crypto from "crypto";
import puppeteer from "puppeteer";
import { unauthenticated } from "./shopify.server";
import type { AdminClient } from "./gift-order.server";

const ACCENT = "#b6862c";
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

type CertificateData = {
  recipientName: string;
  giverName: string;
  activationCode: string;
  shopName: string;
  shopLogoUrl: string | null;
  formattedDate: string;
};

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

  const html = renderCertificateHtml({
    recipientName: escapeHtml(recipientName),
    giverName: escapeHtml(giverName),
    activationCode: escapeHtml(activationCode),
    shopName: escapeHtml(shopName),
    shopLogoUrl,
    formattedDate,
  });

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

function renderCertificateHtml(data: CertificateData): string {
  const { recipientName, giverName, activationCode, shopName, shopLogoUrl, formattedDate } = data;
  const initial = shopName.slice(0, 1).toUpperCase();

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=Cormorant+Garamond:ital,wght@0,500;1,500&display=swap');

  * { box-sizing: border-box; }
  body { margin: 0; }

  .ttgc-certificate {
    width: 100%;
    min-height: 940px;
    padding: 22px;
    background: #f4efe3;
    color: #16283f;
    font-family: "Helvetica Neue", Arial, sans-serif;
  }

  .ttgc-frame {
    position: relative;
    min-height: 896px;
    background: #fffdf9;
    border: 2px solid #16283f;
    padding: 6px;
    overflow: hidden;
  }

  .ttgc-frame:before {
    content: "";
    position: absolute;
    inset: 6px;
    border: 1px solid ${ACCENT};
    z-index: 2;
    pointer-events: none;
  }

  .ttgc-frame:after {
    content: "";
    position: absolute;
    inset: 12px;
    border: 1px solid rgba(22, 40, 63, 0.25);
    z-index: 2;
    pointer-events: none;
  }

  .ttgc-corner {
    position: absolute;
    width: 34px;
    height: 34px;
    border-color: ${ACCENT};
    z-index: 2;
  }

  .ttgc-corner-tl { top: 18px; left: 18px; border-top: 2px solid; border-left: 2px solid; }
  .ttgc-corner-tr { top: 18px; right: 18px; border-top: 2px solid; border-right: 2px solid; }
  .ttgc-corner-bl { bottom: 18px; left: 18px; border-bottom: 2px solid; border-left: 2px solid; }
  .ttgc-corner-br { bottom: 18px; right: 18px; border-bottom: 2px solid; border-right: 2px solid; }

  .ttgc-watermark {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-family: "Playfair Display", Georgia, serif;
    font-weight: 800;
    font-size: 420px;
    line-height: 1;
    color: #16283f;
    opacity: 0.045;
    z-index: 1;
    pointer-events: none;
    user-select: none;
  }

  .ttgc-body {
    position: relative;
    z-index: 3;
    min-height: 824px;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 48px 64px 32px;
    text-align: center;
  }

  .ttgc-brand {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .ttgc-logo {
    max-width: 170px;
    max-height: 60px;
    object-fit: contain;
  }

  .ttgc-brand-name {
    font-family: "Playfair Display", Georgia, serif;
    font-size: 20px;
    font-weight: 700;
    color: #16283f;
    letter-spacing: 0.5px;
  }

  .ttgc-brand-rule {
    width: 60px;
    height: 2px;
    background: ${ACCENT};
    margin-top: 14px;
  }

  .ttgc-heading-block { margin-top: 34px; }

  .ttgc-kicker {
    color: ${ACCENT};
    text-transform: uppercase;
    letter-spacing: 3px;
    font-size: 12px;
    font-weight: 700;
  }

  .ttgc-title {
    margin-top: 18px;
    font-family: "Playfair Display", Georgia, serif;
    font-size: 66px;
    line-height: 1.05;
    font-weight: 800;
    color: #16283f;
  }

  .ttgc-subtitle {
    margin-top: 14px;
    text-transform: uppercase;
    letter-spacing: 2px;
    font-size: 15px;
    color: #4a5b70;
  }

  .ttgc-divider {
    margin-top: 32px;
    display: flex;
    align-items: center;
    width: 360px;
  }

  .ttgc-divider-line { flex: 1; height: 1px; background: ${ACCENT}; }

  .ttgc-divider-mark {
    width: 8px;
    height: 8px;
    margin: 0 10px;
    background: ${ACCENT};
    transform: rotate(45deg);
    flex-shrink: 0;
  }

  .ttgc-recipient-block { margin-top: 36px; }

  .ttgc-presented-label {
    text-transform: uppercase;
    letter-spacing: 2.4px;
    font-size: 12px;
    font-weight: 700;
    color: #6b7889;
  }

  .ttgc-recipient-name {
    display: inline-block;
    min-width: 520px;
    max-width: 700px;
    margin-top: 16px;
    padding-bottom: 12px;
    border-bottom: 2px solid ${ACCENT};
    font-family: "Cormorant Garamond", Georgia, serif;
    font-style: italic;
    font-weight: 500;
    font-size: 58px;
    line-height: 1.15;
    color: #16283f;
  }

  .ttgc-giver-line {
    margin-top: 22px;
    font-size: 16px;
    font-style: italic;
    color: #4a5b70;
  }

  .ttgc-giver-line strong { font-style: normal; color: #16283f; }

  .ttgc-code-card {
    margin-top: 36px;
    width: 380px;
    max-width: 100%;
    padding: 20px 28px;
    background: #16283f;
    border-top: 3px solid ${ACCENT};
    border-bottom: 3px solid ${ACCENT};
  }

  .ttgc-code-label {
    color: #ffffff;
    text-transform: uppercase;
    letter-spacing: 2.2px;
    font-size: 11px;
    font-weight: 700;
  }

  .ttgc-code-value {
    margin-top: 10px;
    color: #ffffff;
    font-family: "Courier New", monospace;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 2.5px;
  }

  .ttgc-instructions {
    margin-top: 22px;
    max-width: 520px;
    font-size: 13px;
    line-height: 1.6;
    color: #4a5b70;
  }

  .ttgc-footer {
    margin-top: auto;
    padding-top: 30px;
    width: 100%;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    text-align: left;
  }

  .ttgc-footer-left { display: flex; flex-direction: column; gap: 8px; }
  .ttgc-footer-row { display: flex; align-items: baseline; gap: 8px; }

  .ttgc-footer-label {
    text-transform: uppercase;
    letter-spacing: 1.6px;
    font-size: 10px;
    font-weight: 700;
    color: #8592a1;
  }

  .ttgc-footer-value { font-size: 13px; color: #16283f; }

  .ttgc-seal { display: flex; flex-direction: column; align-items: center; }

  .ttgc-seal-wrap {
    position: relative;
    width: 70px;
    height: 70px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ttgc-seal-ring {
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    border: 2px solid ${ACCENT};
    background: #fffdf9;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ttgc-seal-ring:before {
    content: "";
    position: absolute;
    inset: 4px;
    border: 1px solid #16283f;
    border-radius: 50%;
  }

  .ttgc-seal-tick {
    position: absolute;
    width: 5px;
    height: 5px;
    background: ${ACCENT};
    transform: rotate(45deg);
  }

  .ttgc-seal-tick-top { top: -2px; left: 50%; margin-left: -2.5px; }
  .ttgc-seal-tick-bottom { bottom: -2px; left: 50%; margin-left: -2.5px; }
  .ttgc-seal-tick-left { left: -2px; top: 50%; margin-top: -2.5px; }
  .ttgc-seal-tick-right { right: -2px; top: 50%; margin-top: -2.5px; }

  .ttgc-seal-letter {
    font-family: "Playfair Display", Georgia, serif;
    font-size: 22px;
    font-weight: 700;
    color: #16283f;
  }

  .ttgc-seal-caption {
    margin-top: 6px;
    text-transform: uppercase;
    letter-spacing: 1.4px;
    font-size: 9px;
    color: #8592a1;
  }
</style>
</head>
<body>
  <div class="ttgc-certificate">
    <div class="ttgc-frame">
      <div class="ttgc-corner ttgc-corner-tl"></div>
      <div class="ttgc-corner ttgc-corner-tr"></div>
      <div class="ttgc-corner ttgc-corner-bl"></div>
      <div class="ttgc-corner ttgc-corner-br"></div>

      <div class="ttgc-watermark">${initial}</div>

      <div class="ttgc-body">
        <div class="ttgc-brand">
          ${
            shopLogoUrl
              ? `<img src="${shopLogoUrl}" class="ttgc-logo" alt="${shopName}">`
              : `<div class="ttgc-brand-name">${shopName}</div>`
          }
          <div class="ttgc-brand-rule"></div>
        </div>

        <div class="ttgc-heading-block">
          <div class="ttgc-kicker">Certificate of Gift Subscription</div>
          <div class="ttgc-title">TropeTrainer</div>
          <div class="ttgc-subtitle">One-Year Online Subscription</div>
        </div>

        <div class="ttgc-divider">
          <span class="ttgc-divider-line"></span>
          <span class="ttgc-divider-mark"></span>
          <span class="ttgc-divider-line"></span>
        </div>

        <div class="ttgc-recipient-block">
          <div class="ttgc-presented-label">This certificate is presented to</div>
          <div class="ttgc-recipient-name">${recipientName || "Recipient Name"}</div>
          <div class="ttgc-giver-line">
            with a gift subscription from
            <strong>${giverName || "Gift Giver"}</strong>
          </div>
        </div>

        <div class="ttgc-code-card">
          <div class="ttgc-code-label">Activation Code</div>
          <div class="ttgc-code-value">${activationCode || "TT-XXXX-XXXX"}</div>
        </div>

        <p class="ttgc-instructions">
          Redeem at <strong>tropetrainer.com</strong> using the activation code above to begin your one-year subscription.
        </p>

        <div class="ttgc-footer">
          <div class="ttgc-footer-left">
            <div class="ttgc-footer-row">
              <span class="ttgc-footer-label">Issued</span>
              <strong class="ttgc-footer-value">${formattedDate}</strong>
            </div>
            <div class="ttgc-footer-row">
              <span class="ttgc-footer-label">Purchased through</span>
              <strong class="ttgc-footer-value">${shopName}</strong>
            </div>
          </div>

          <div class="ttgc-seal">
            <div class="ttgc-seal-wrap">
              <span class="ttgc-seal-tick ttgc-seal-tick-top"></span>
              <span class="ttgc-seal-tick ttgc-seal-tick-right"></span>
              <span class="ttgc-seal-tick ttgc-seal-tick-bottom"></span>
              <span class="ttgc-seal-tick ttgc-seal-tick-left"></span>
              <div class="ttgc-seal-ring">
                <span class="ttgc-seal-letter">${initial}</span>
              </div>
            </div>
            <div class="ttgc-seal-caption">Gift Certificate</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}
