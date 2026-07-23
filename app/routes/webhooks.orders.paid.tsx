import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createAccessCode } from "../tropetrainer.server";

const GIFT_PRODUCT_TAG = "subscription_gift";
const FAILED_TAG = "tropetrainer_code_failed";
const CREATED_TAG = "tropetrainer_code_created";
const METAFIELD_NAMESPACE = "custom";
const METAFIELD_KEY = "tropetrainer_code";

type AdminClient = NonNullable<Awaited<ReturnType<typeof authenticate.webhook>>["admin"]>;

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

async function addTag(admin: AdminClient, orderGid: string, tag: string) {
  await admin.graphql(
    `#graphql
    mutation AddOrderTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { message }
      }
    }`,
    { variables: { id: orderGid, tags: [tag] } },
  );
}

async function removeTag(admin: AdminClient, orderGid: string, tag: string) {
  await admin.graphql(
    `#graphql
    mutation RemoveOrderTag($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { message }
      }
    }`,
    { variables: { id: orderGid, tags: [tag] } },
  );
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

  // Guard 1: Shopify metafield already has a code (e.g. a previous run succeeded
  // but our DB record is missing/stale) — sync our record and stop, no API call.
  const metafieldResp = await admin.graphql(
    `#graphql
    query OrderMetafield($id: ID!, $namespace: String!, $key: String!) {
      order(id: $id) {
        metafield(namespace: $namespace, key: $key) {
          value
        }
      }
    }`,
    {
      variables: { id: orderGid, namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY },
    },
  );
  const metafieldJson = await metafieldResp.json();
  const existingCode: string | undefined = metafieldJson.data?.order?.metafield?.value;

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

  await db.giftCode.upsert({
    where: { shopifyOrderId },
    create: { shop, shopifyOrderId, shopifyOrderName, idempotencyKey, status: "pending" },
    update: { status: "pending", errorCode: null, errorMessage: null },
  });

  const result = await createAccessCode(idempotencyKey);

  if (!result.ok) {
    console.error(
      `TropeTrainer access code creation failed for order ${shopifyOrderName}: ` +
        `[${result.errorCode ?? "unknown"}] ${result.message} (retryable=${result.retryable}, requestId=${result.requestId})`,
    );
    await db.giftCode.update({
      where: { shopifyOrderId },
      data: {
        status: "failed",
        errorCode: result.errorCode,
        errorMessage: result.message,
        requestId: result.requestId,
      },
    });
    await addTag(admin, orderGid, FAILED_TAG);

    if (result.retryable) {
      // Returning non-2xx makes Shopify redeliver this webhook later. Safe to
      // retry: the idempotency key is stable per order, so TropeTrainer returns
      // the original result instead of creating a duplicate code/charge.
      return new Response("Retryable TropeTrainer error, requesting webhook redelivery", {
        status: 500,
      });
    }
    // Non-retryable (e.g. payment_declined) — retrying won't help until the
    // underlying issue (billing, etc.) is fixed, so accept the webhook as-is.
    return new Response();
  }

  await db.giftCode.update({
    where: { shopifyOrderId },
    data: {
      status: "issued",
      code: result.code,
      accessCodeId: result.accessCodeId,
      requestId: result.requestId,
      errorCode: null,
      errorMessage: null,
    },
  });

  await admin.graphql(
    `#graphql
    mutation SetTropeTrainerCode($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { message }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: orderGid,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            type: "single_line_text_field",
            value: result.code,
          },
        ],
      },
    },
  );

  await addTag(admin, orderGid, CREATED_TAG);
  // Clean up a stale failed-tag if this succeeded on a retry after an earlier failure.
  await removeTag(admin, orderGid, FAILED_TAG);

  return new Response();
};
