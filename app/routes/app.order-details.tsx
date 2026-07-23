import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export type OrderDetails = {
  name: string;
  createdAt: string;
  customerName: string | null;
  customerEmail: string | null;
  financialStatus: string;
  fulfillmentStatus: string;
  totalPrice: string;
  currency: string;
  shippingAddress: string | null;
  tags: string[];
  lineItems: { title: string; quantity: number; price: string }[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return json({ error: "Missing id" }, { status: 400 });
  }

  const resp = await admin.graphql(
    `#graphql
    query OrderDetails($id: ID!) {
      order(id: $id) {
        name
        createdAt
        tags
        email
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        shippingAddress {
          name
          address1
          address2
          city
          province
          zip
          country
        }
        lineItems(first: 20) {
          edges {
            node {
              title
              quantity
              originalUnitPriceSet { shopMoney { amount } }
            }
          }
        }
      }
    }`,
    { variables: { id: `gid://shopify/Order/${id}` } },
  );
  const respJson = await resp.json();
  const order = respJson.data?.order;
  if (!order) {
    return json({ error: "Order not found" }, { status: 404 });
  }

  const shippingAddress = order.shippingAddress
    ? [
        order.shippingAddress.name,
        order.shippingAddress.address1,
        order.shippingAddress.address2,
        [order.shippingAddress.city, order.shippingAddress.province, order.shippingAddress.zip]
          .filter(Boolean)
          .join(", "),
        order.shippingAddress.country,
      ]
        .filter(Boolean)
        .join("\n")
    : null;

  const details: OrderDetails = {
    name: order.name,
    createdAt: order.createdAt,
    customerName: order.shippingAddress?.name ?? null,
    customerEmail: order.email ?? null,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    totalPrice: order.totalPriceSet.shopMoney.amount,
    currency: order.totalPriceSet.shopMoney.currencyCode,
    shippingAddress,
    tags: order.tags ?? [],
    lineItems: order.lineItems.edges.map(
      (e: {
        node: {
          title: string;
          quantity: number;
          originalUnitPriceSet: { shopMoney: { amount: string } };
        };
      }) => ({
        title: e.node.title,
        quantity: e.node.quantity,
        price: e.node.originalUnitPriceSet.shopMoney.amount,
      }),
    ),
  };

  return json({ order: details });
};
