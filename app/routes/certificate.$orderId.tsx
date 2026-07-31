import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isRouteErrorResponse, useRouteError } from "@remix-run/react";
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

function fixedError(reason: keyof typeof FIXED_COPY, status: number) {
  return json({ ...FIXED_COPY[reason] }, { status });
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
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const orderId = params.orderId;
  if (!orderId) {
    throw fixedError("invalid", 400);
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const shopParam = url.searchParams.get("shop");
  const key = url.searchParams.get("key");

  const tokenValid = Boolean(token && isValidCertificateToken(orderId, token));
  const shopKeyValid = Boolean(shopParam && key && isValidShopCertificateKey(shopParam, key));

  if (!tokenValid && !shopKeyValid) {
    throw fixedError("invalid", 403);
  }

  const record = await db.giftCode.findUnique({ where: { shopifyOrderId: orderId } });

  // The shop-key path proves the request knows a valid key for shopParam,
  // but not that shopParam is actually this order's shop — check that too,
  // so a valid key for shop A can't be paired with an order id from shop B.
  if (record && shopKeyValid && !tokenValid && record.shop !== shopParam) {
    throw fixedError("invalid", 403);
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

    throw json(
      {
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
      },
      { status: 202 },
    );
  }

  const pdf = await generateCertificatePdf(record.shop, orderId);
  if (!pdf) {
    throw fixedError("error", 500);
  }

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="gift-certificate-${record.shopifyOrderName.replace("#", "")}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
};

export function ErrorBoundary() {
  const error = useRouteError();
  const data = isRouteErrorResponse(error) ? error.data : null;
  const heading = data?.heading ?? "Something went wrong";
  const body =
    data?.body ?? "Please try again in a few minutes, or contact us if this keeps happening.";
  const firstName: string | null = data?.firstName ?? null;
  const contactHref: string | null = data?.contactHref ?? null;
  const delayed: boolean = data?.delayed ?? false;

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f4f4f4",
        fontFamily: "Arial, Helvetica, sans-serif",
        padding: "24px",
      }}
    >
      <div
        style={{
          maxWidth: "460px",
          width: "100%",
          background: "#ffffff",
          borderRadius: "12px",
          padding: "40px 36px",
          textAlign: "center",
          boxShadow: "0 1px 6px rgba(0, 0, 0, 0.08)",
        }}
      >
        {firstName && (
          <p style={{ fontSize: "15px", color: "#6b7889", margin: "0 0 4px" }}>Hi {firstName},</p>
        )}
        <h1 style={{ fontSize: "22px", margin: "0 0 12px", color: "#16283f" }}>{heading}</h1>
        <p style={{ fontSize: "15px", lineHeight: 1.6, color: "#4a5b70", margin: 0 }}>{body}</p>
        {contactHref && delayed && (
          <a
            href={contactHref}
            style={{
              display: "inline-block",
              marginTop: "24px",
              padding: "10px 22px",
              background: "#16283f",
              color: "#ffffff",
              borderRadius: "8px",
              textDecoration: "none",
              fontSize: "14px",
              fontWeight: 600,
            }}
          >
            Contact us
          </a>
        )}
        {contactHref && !delayed && (
          <p style={{ fontSize: "13px", color: "#8592a1", margin: "18px 0 0" }}>
            Still don't see it?{" "}
            <a href={contactHref} style={{ color: "#2c6ecb", textDecoration: "underline" }}>
              You can contact us
            </a>
            .
          </p>
        )}
      </div>
    </div>
  );
}
