import type { LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { checkAccessCodeStatus } from "../tropetrainer.server";

// Public, unauthenticated JSON API — called via fetch() from a widget
// embedded in the storefront theme (a different origin than this app), so
// it needs CORS headers. Deliberately returns only the minimal status info
// (never order/customer details) since anyone can query any code — this
// matches TropeTrainer's own guidance not to expose recipient identity or
// activity beyond redemption status.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const rawCode = url.searchParams.get("code");
  const code = rawCode?.trim().toUpperCase();

  if (!code) {
    return jsonResponse({ found: false, message: "Enter a code to check." }, 400);
  }

  const record = await db.giftCode.findFirst({
    where: { code },
    select: { id: true, idempotencyKey: true, status: true, redeemedAt: true },
  });

  if (!record) {
    return jsonResponse({ found: false, message: "We couldn't find that code." });
  }

  // TropeTrainer's status endpoint only accepts our internal idempotency
  // key, never the customer-facing code — that lookup happens first above.
  const live = await checkAccessCodeStatus(record.idempotencyKey);

  if (!live.ok) {
    // Live check failed (network blip, rate limit, etc.) — fall back to our
    // last-known status rather than showing an error for a working code.
    return jsonResponse({
      found: true,
      status: record.status,
      redeemedAt: record.redeemedAt,
      live: false,
    });
  }

  // Keep our own record in sync with what we just learned, same as the
  // periodic sync job — a live check is itself a status refresh.
  if (live.status !== record.status || live.redeemedAt) {
    await db.giftCode
      .update({
        where: { id: record.id },
        data: {
          status: live.status,
          redeemedAt: live.redeemedAt ? new Date(live.redeemedAt) : record.redeemedAt,
          statusCheckedAt: new Date(),
        },
      })
      .catch(() => {});
  }

  return jsonResponse({
    found: true,
    status: live.status,
    redeemedAt: live.redeemedAt ?? record.redeemedAt,
    live: true,
  });
};

// Browsers may send an OPTIONS preflight before the actual GET.
export const action = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return jsonResponse({ found: false, message: "Method not allowed." }, 405);
};
