import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createAccessCode } from "../tropetrainer.server";

const GIFT_LINE_ITEM_PROPERTIES = ["Recipient name", "Gift giver name"];
const METAFIELD_NAMESPACE = "custom";
const METAFIELD_KEY = "tropetrainer_code";

type OrderPayload = {
  id: number;
  name: string;
  admin_graphql_api_id: string;
  line_items?: { properties?: { name: string; value: string }[] }[];
};

function isGiftSubscriptionOrder(payload: OrderPayload): boolean {
  const lineItems = payload.line_items ?? [];
  return lineItems.some((item) => {
    const propNames = (item.properties ?? []).map((p) => p.name);
    return GIFT_LINE_ITEM_PROPERTIES.every((name) => propNames.includes(name));
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const order = payload as OrderPayload;

  console.log(`Received ${topic} webhook for ${shop}, order ${order.name}`);

  if (!admin) {
    console.error(`No admin session for ${shop}; cannot process order ${order.name}`);
    return new Response();
  }

  if (!isGiftSubscriptionOrder(order)) {
    return new Response();
  }

  const orderGid = order.admin_graphql_api_id;
  const shopifyOrderId = String(order.id);
  const shopifyOrderName = order.name;
  const idempotencyKey = `shopify_order_${shopifyOrderId}`;

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
    update: { status: "pending", errorMessage: null },
  });

  const result = await createAccessCode(idempotencyKey);

  if (!result.ok) {
    console.error(
      `TropeTrainer access code creation failed for order ${shopifyOrderName}: ${result.error}`,
    );
    await db.giftCode.update({
      where: { shopifyOrderId },
      data: { status: "failed", errorMessage: result.error },
    });
    await admin.graphql(
      `#graphql
      mutation AddFailedTag($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { message }
        }
      }`,
      { variables: { id: orderGid, tags: ["tropetrainer_code_failed"] } },
    );
    return new Response();
  }

  await db.giftCode.update({
    where: { shopifyOrderId },
    data: {
      status: "issued",
      code: result.code,
      accessCodeId: result.accessCodeId,
      requestId: result.requestId,
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

  await admin.graphql(
    `#graphql
    mutation AddCreatedTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { message }
      }
    }`,
    { variables: { id: orderGid, tags: ["tropetrainer_code_created"] } },
  );

  return new Response();
};
