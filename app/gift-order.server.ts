import { authenticate } from "./shopify.server";
import db from "./db.server";
import { createAccessCode } from "./tropetrainer.server";

export const GIFT_PRODUCT_TAG = "subscription_gift";
export const FAILED_TAG = "tropetrainer_code_failed";
export const CREATED_TAG = "tropetrainer_code_created";
export const METAFIELD_NAMESPACE = "custom";
export const METAFIELD_KEY = "tropetrainer_code";

export type AdminClient = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

export async function addTag(admin: AdminClient, orderGid: string, tag: string) {
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

export async function removeTag(admin: AdminClient, orderGid: string, tag: string) {
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

export async function getOrderMetafieldCode(
  admin: AdminClient,
  orderGid: string,
): Promise<string | undefined> {
  const resp = await admin.graphql(
    `#graphql
    query OrderMetafield($id: ID!, $namespace: String!, $key: String!) {
      order(id: $id) {
        metafield(namespace: $namespace, key: $key) { value }
      }
    }`,
    { variables: { id: orderGid, namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY } },
  );
  const json = await resp.json();
  return json.data?.order?.metafield?.value;
}

export async function hasAnyGiftProduct(admin: AdminClient): Promise<boolean> {
  const resp = await admin.graphql(
    `#graphql
    query HasGiftProduct($query: String!) {
      products(first: 1, query: $query) {
        edges { node { id } }
      }
    }`,
    { variables: { query: `tag:${GIFT_PRODUCT_TAG}` } },
  );
  const json = await resp.json();
  return (json.data?.products?.edges ?? []).length > 0;
}

type AttemptResult = { ok: true } | { ok: false; retryable: boolean };

// The single place that ever calls TropeTrainer and reconciles the result
// against Shopify. Used by both the orders/paid webhook and the admin "Retry"
// action, so there is exactly one code path — no drift between the two entry points.
export async function attemptIssueCode(params: {
  admin: AdminClient;
  shop: string;
  orderGid: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  idempotencyKey: string;
}): Promise<AttemptResult> {
  const { admin, shop, orderGid, shopifyOrderId, shopifyOrderName, idempotencyKey } = params;

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
    return { ok: false, retryable: result.retryable };
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
  await removeTag(admin, orderGid, FAILED_TAG);

  return { ok: true };
}
