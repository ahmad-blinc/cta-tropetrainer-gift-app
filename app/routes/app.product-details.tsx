import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export type ProductDetails = {
  title: string;
  status: string;
  vendor: string;
  productType: string;
  tags: string[];
  totalInventory: number;
  priceRangeMin: string;
  priceRangeMax: string;
  currency: string;
  imageUrl: string | null;
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
    query ProductDetails($id: ID!) {
      product(id: $id) {
        title
        status
        vendor
        productType
        tags
        totalInventory
        featuredImage { url }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount }
        }
      }
    }`,
    { variables: { id: `gid://shopify/Product/${id}` } },
  );
  const respJson = await resp.json();
  const product = respJson.data?.product;
  if (!product) {
    return json({ error: "Product not found" }, { status: 404 });
  }

  const details: ProductDetails = {
    title: product.title,
    status: product.status,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags ?? [],
    totalInventory: product.totalInventory,
    priceRangeMin: product.priceRangeV2.minVariantPrice.amount,
    priceRangeMax: product.priceRangeV2.maxVariantPrice.amount,
    currency: product.priceRangeV2.minVariantPrice.currencyCode,
    imageUrl: product.featuredImage?.url ?? null,
  };

  return json({ product: details });
};
