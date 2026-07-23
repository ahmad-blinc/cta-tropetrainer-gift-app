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

  // Mark the order as a gift-subscription order regardless of how the
  // TropeTrainer call below goes. tagsAdd is idempotent, safe on webhook redelivery.
  await addTag(admin, orderGid, GIFT_PRODUCT_TAG);

  // Save the signed certificate link as early as possible — before the
  // TropeTrainer call — so it's ready well before Shopify's order-confirmation
  // email sends. The certificate route generates the PDF on demand at click
  // time, so the link doesn't need the code to exist yet, only the order to.
  await saveCertificateUrlMetafield(admin, orderGid, shopifyOrderId);

  // Guard 1: Shopify metafield already has a code (e.g. a previous run succeeded
  // but our DB record is missing/stale) — sync our record and stop, no API call.
  const existingCode = await getOrderMetafieldCode(admin, orderGid);
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

  const result = await attemptIssueCode({
    admin,
    shop,
    orderGid,
    shopifyOrderId,
    shopifyOrderName,
    idempotencyKey,
  });

  if (!result.ok && result.retryable) {
    // Returning non-2xx makes Shopify redeliver this webhook later. Safe to
    // retry: the idempotency key is stable per order, so TropeTrainer returns
    // the original result instead of creating a duplicate code/charge.
    return new Response("Retryable TropeTrainer error, requesting webhook redelivery", {
      status: 500,
    });
  }

  return new Response();
};
