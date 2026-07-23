import type { LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { generateCertificatePdf, isValidCertificateToken } from "../certificate.server";

// Public route — opened directly by customers from an email, not through the
// embedded admin, so it must not use authenticate.admin(). Access is instead
// controlled by a signed per-order token in the query string.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const orderId = params.orderId;
  if (!orderId) {
    throw new Response("Missing order id", { status: 400 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token || !isValidCertificateToken(orderId, token)) {
    throw new Response("Invalid or missing token", { status: 403 });
  }

  const record = await db.giftCode.findUnique({ where: { shopifyOrderId: orderId } });
  if (!record) {
    throw new Response("Certificate not found", { status: 404 });
  }
  if (record.status !== "issued") {
    throw new Response("This certificate is still being prepared. Please check back shortly.", {
      status: 202,
    });
  }

  const pdf = await generateCertificatePdf(record.shop, orderId);
  if (!pdf) {
    throw new Response("Could not generate certificate", { status: 500 });
  }

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="gift-certificate-${record.shopifyOrderName.replace("#", "")}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
};
