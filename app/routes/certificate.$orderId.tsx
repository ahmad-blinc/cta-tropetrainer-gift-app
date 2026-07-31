import type { LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import {
  generateCertificatePdf,
  isValidCertificateToken,
  isValidShopCertificateKey,
  getGiverFirstName,
} from "../certificate.server";
import {
  getCertificateStatusMessages,
  resolveContactHref,
  shouldShowContactLink,
} from "../certificate-status.server";

const DELAY_ESCALATION_MS = 24 * 60 * 60 * 1000;

const FIXED_COPY = {
  invalid: {
    heading: "This link isn't valid",
    body: "This certificate link looks incorrect or may have expired. Please check the link in your email, or contact us for help.",
  },
  error: {
    heading: "Something went wrong",
    body: "We couldn't generate your certificate just now. Please try again in a few minutes, or contact us if this keeps happening.",
  },
};

// Escape user/CMS-controlled strings before interpolating into hand-built HTML below.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderStatusPage(opts: {
  heading: string;
  body: string;
  firstName?: string | null;
  contactHref?: string | null;
  delayed?: boolean;
}) {
  const { heading, body, firstName, contactHref, delayed } = opts;
  const greeting = firstName
    ? `<p style="font-size:15px;color:#6b7889;margin:0 0 4px">Hi ${escapeHtml(firstName)},</p>`
    : "";
  const contactBlock =
    contactHref && delayed
      ? `<a href="${escapeHtml(contactHref)}" style="display:inline-block;margin-top:24px;padding:10px 22px;background:#16283f;color:#ffffff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">Contact us</a>`
      : contactHref && !delayed
        ? `<p style="font-size:13px;color:#8592a1;margin:18px 0 0">Still don't see it? <a href="${escapeHtml(contactHref)}" style="color:#2c6ecb;text-decoration:underline">You can contact us</a>.</p>`
        : "";

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(heading)}</title>
  </head>
  <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;padding:24px">
    <div style="max-width:460px;width:100%;background:#ffffff;border-radius:12px;padding:40px 36px;text-align:center;box-shadow:0 1px 6px rgba(0,0,0,0.08)">
      ${greeting}
      <h1 style="font-size:22px;margin:0 0 12px;color:#16283f">${escapeHtml(heading)}</h1>
      <p style="font-size:15px;line-height:1.6;color:#4a5b70;margin:0">${escapeHtml(body)}</p>
      ${contactBlock}
    </div>
  </body>
</html>`;
}

function statusResponse(
  reason: keyof typeof FIXED_COPY,
  status: number,
  extra?: { firstName?: string | null; contactHref?: string | null; delayed?: boolean },
) {
  return new Response(renderStatusPage({ ...FIXED_COPY[reason], ...extra }), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// Public route — opened directly by customers from an email, not through the
// embedded admin, so it must not use authenticate.admin(). Two independent
// ways in:
//  - ?token=... — a per-order signed token (strongest; used by the
//    certificate_url metafield and the app's own "View certificate PDF").
//  - ?shop=...&key=... — a per-shop key, valid for any order at that shop.
//    Weaker, but computable entirely from data Shopify's Liquid already has
//    at email-render time ({{ order.id }}), so it's what the order
//    confirmation email snippet uses — no dependency on our webhook having
//    run yet, which is what made the metafield-based link unreliable there.
//
// This route deliberately has no default export and no ErrorBoundary —
// Remix only serves a loader's raw Response (needed for the PDF bytes below)
// when the route module has neither, otherwise every response gets wrapped
// in the full HTML document shell. So every non-PDF outcome here returns a
// hand-built HTML Response directly instead of throwing.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const orderId = params.orderId;
  if (!orderId) {
    return statusResponse("invalid", 400);
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const shopParam = url.searchParams.get("shop");
  const key = url.searchParams.get("key");

  const tokenValid = Boolean(token && isValidCertificateToken(orderId, token));
  const shopKeyValid = Boolean(shopParam && key && isValidShopCertificateKey(shopParam, key));

  if (!tokenValid && !shopKeyValid) {
    return statusResponse("invalid", 403);
  }

  const record = await db.giftCode.findUnique({ where: { shopifyOrderId: orderId } });

  // The shop-key path proves the request knows a valid key for shopParam,
  // but not that shopParam is actually this order's shop — check that too,
  // so a valid key for shop A can't be paired with an order id from shop B.
  if (record && shopKeyValid && !tokenValid && record.shop !== shopParam) {
    return statusResponse("invalid", 403);
  }

  // Under the shop-key scheme, a missing/not-yet-issued record is expected
  // shortly after checkout (our webhook may not have finished yet). Whatever
  // the underlying reason (still pending, or TropeTrainer genuinely failed),
  // customers see the same calm "still processing" message so a transient
  // delay never reads as broken — it only escalates to a different message
  // once it's been unresolved long enough that a human should look at it.
  if (!record || record.status !== "issued") {
    const shop = record?.shop ?? (shopKeyValid ? shopParam! : null);
    const [messages, firstName] = await Promise.all([
      shop ? getCertificateStatusMessages(shop) : null,
      shop ? getGiverFirstName(shop, orderId) : null,
    ]);
    const ageMs = record ? Date.now() - record.createdAt.getTime() : 0;
    const delayed = ageMs > DELAY_ESCALATION_MS;

    return new Response(
      renderStatusPage({
        heading: delayed
          ? (messages?.delayedHeading ?? "Your certificate is taking longer than expected")
          : (messages?.processingHeading ?? "Your certificate is being processed"),
        body: delayed
          ? (messages?.delayedBody ??
            "Please contact us and we'll help sort this out right away.")
          : (messages?.processingBody ??
            "Please try refreshing this page, or reopen this link again in 2–3 minutes."),
        firstName,
        delayed,
        contactHref:
          messages?.contactLink && shouldShowContactLink(messages.contactLinkVisibility, delayed)
            ? resolveContactHref(messages.contactLink)
            : null,
      }),
      { status: 202, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const pdf = await generateCertificatePdf(record.shop, orderId);
  if (!pdf) {
    return statusResponse("error", 500);
  }

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="gift-certificate-${record.shopifyOrderName.replace("#", "")}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
};
