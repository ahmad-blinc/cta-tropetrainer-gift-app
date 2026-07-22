const { PrismaClient } = require("@prisma/client");

const SHOP = "blinctest.myshopify.com";
const API_VERSION = "2025-01";
const VARIANT_ID = 49946855145769; // The Inventory Not Tracked Snowboard

async function rest(token, path, method, body) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function gql(token, query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function main() {
  const db = new PrismaClient();
  const session = await db.session.findFirst({ where: { shop: SHOP } });
  if (!session) throw new Error("No session found for " + SHOP);
  const token = session.accessToken;

  console.log("1. Creating an unpaid order directly via REST (write_orders scope only)...");
  const orderData = await rest(token, "orders.json", "POST", {
    order: {
      line_items: [
        {
          variant_id: VARIANT_ID,
          quantity: 1,
          properties: [
            { name: "Recipient name", value: "Test Recipient" },
            { name: "Gift giver name", value: "Test Giver" },
          ],
        },
      ],
      financial_status: "pending",
      gateway: "manual",
      send_receipt: false,
      send_fulfillment_receipt: false,
    },
  });
  const order = orderData.order;
  console.log("   order:", order.name, order.admin_graphql_api_id);

  console.log("1b. Posting a real 'sale' transaction to mark it paid (this is what actually fires orders/paid)...");
  await rest(token, `orders/${order.id}/transactions.json`, "POST", {
    transaction: {
      kind: "sale",
      status: "success",
      amount: order.total_price,
      source: "external",
    },
  });

  console.log("2. Polling order for webhook processing result (metafield + tags)...");
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const check = await gql(token, `
      query($id: ID!) {
        order(id: $id) {
          tags
          metafield(namespace: "custom", key: "tropetrainer_code") { value }
        }
      }
    `, { id: order.admin_graphql_api_id });
    console.log(`   [${i + 1}] tags=${JSON.stringify(check.order.tags)} metafield=${JSON.stringify(check.order.metafield?.value ?? null)}`);
    if (check.order.tags.some((t) => t.includes("tropetrainer_code"))) {
      console.log("Webhook processed - tag found, stopping poll.");
      break;
    }
  }

  await db.$disconnect();
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
