import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  addTag,
  attemptIssueCode,
  getOrderMetafieldCode,
  GIFT_PRODUCT_TAG,
  type AdminClient,
} from "../gift-order.server";
import { saveCertificateUrlMetafield } from "../certificate.server";

// Shopify gives a webhook 5 seconds to respond, then treats it as failed and
// redelivers it. Creating a TropeTrainer code (which charges a card) can take
// longer than that, so the code is issued in the background after we've
// already answered Shopify. Railway runs one long-lived Node process, so the
// background work keeps running after the response is sent.
const BACKGROUND_MAX_ATTEMPTS = 6;

// Orders whose code is being issued right now in this process — a duplicate
// delivery of the same webhook while that's running is acknowledged and skipped.
const inFlightOrders = new Set<string>();

type OrderPayload = {
  id: number;
  name: string;
  admin_graphql_api_id: string;
  line_items?: { product_id?: number | null }[];
};

async function isGiftSubscriptionOrder(
  admin: AdminClient,
  payload: OrderPayload,
): Promise<boolean> {
  const productIds = Array.from(
    new Set(
      (payload.line_items ?? [])
        .map((item) => item.product_id)
        .filter((id): id is number => id != null),
    ),
  );
  if (productIds.length === 0) return false;

  const productGids = productIds.map((id) => `gid://shopify/Product/${id}`);
  const resp = await admin.graphql(
    `#graphql
    query GiftProductTags($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product { tags }
      }
    }`,
    { variables: { ids: productGids } },
  );
  const json = await resp.json();
  const nodes: { tags?: string[] }[] = json.data?.nodes ?? [];
  return nodes.some((node) => node?.tags?.includes(GIFT_PRODUCT_TAG));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const order = payload as OrderPayload;

  console.log(`Received ${topic} webhook for ${shop}, order ${order.name}`);

  if (!admin) {
    console.error(`No admin session for ${shop}; cannot process order ${order.name}`);
    return new Response();
  }

  if (!(await isGiftSubscriptionOrder(admin, order))) {
    return new Response();
  }

  const orderGid = order.admin_graphql_api_id;
  const shopifyOrderId = String(order.id);
  const shopifyOrderName = order.name;
  const idempotencyKey = `shopify_order_${shopifyOrderId}`;

  if (inFlightOrders.has(shopifyOrderId)) {
    console.log(`Order ${shopifyOrderName}: code already being issued, skipping duplicate delivery`);
    return new Response();
  }

  // Run in parallel to stay well inside Shopify's 5s webhook window:
  //  - tag the order as a gift-subscription order (tagsAdd is idempotent)
  //  - save the signed certificate link before the TropeTrainer call, so it's
  //    ready before Shopify's order-confirmation email sends (the certificate
  //    route generates the PDF on demand, so the code needn't exist yet)
  //  - read any existing code metafield for Guard 1 below
  const [, , existingCode] = await Promise.all([
    addTag(admin, orderGid, GIFT_PRODUCT_TAG),
    saveCertificateUrlMetafield(admin, orderGid, shopifyOrderId),
    getOrderMetafieldCode(admin, orderGid),
  ]);

  // Guard 1: Shopify metafield already has a code (e.g. a previous run succeeded
  // but our DB record is missing/stale) — sync our record and stop, no API call.
  if (existingCode) {
    await db.giftCode.upsert({
      where: { shopifyOrderId },
      create: {
        shop,
        shopifyOrderId,
        shopifyOrderName,
        idempotencyKey,
        status: "issued",
        code: existingCode,
      },
      update: { status: "issued", code: existingCode },
    });
    return new Response();
  }

  // Guard 2: our own DB already has an issued code for this order.
  const existingRecord = await db.giftCode.findUnique({ where: { shopifyOrderId } });
  if (existingRecord?.status === "issued") {
    return new Response();
  }

  // Issue the code in the background and acknowledge Shopify right away.
  // attemptIssueCode retries retryable TropeTrainer errors itself (same
  // idempotency key each time); if every attempt fails, the order is marked
  // failed + tagged, and the admin "Retry" button can re-run it.
  // Re-check: a concurrent delivery may have started while we awaited above.
  if (inFlightOrders.has(shopifyOrderId)) return new Response();
  inFlightOrders.add(shopifyOrderId);
  void attemptIssueCode({
    admin,
    shop,
    orderGid,
    shopifyOrderId,
    shopifyOrderName,
    idempotencyKey,
    maxAttempts: BACKGROUND_MAX_ATTEMPTS,
  })
    .catch((err) => {
      // Must never throw out of here — an unhandled rejection would crash the server.
      console.error(`Background code issuance crashed for order ${shopifyOrderName}:`, err);
    })
    .finally(() => {
      inFlightOrders.delete(shopifyOrderId);
    });

  return new Response();
};
