import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  ResourceList,
  ResourceItem,
  Thumbnail,
  Badge,
  EmptyState,
  Banner,
  Box,
  Divider,
  Modal,
  SkeletonBodyText,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { addTag, removeTag, GIFT_PRODUCT_TAG } from "../gift-order.server";
import { getTropeTrainerConnectionStatus } from "../tropetrainer.server";
import type { ProductDetails } from "./app.product-details";

type GiftProduct = {
  id: string;
  title: string;
  status: string;
  imageUrl: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const resp = await admin.graphql(
    `#graphql
    query GiftProducts {
      products(first: 50, query: "tag:${GIFT_PRODUCT_TAG}") {
        edges {
          node {
            id
            title
            status
            featuredImage { url }
          }
        }
      }
    }`,
  );
  const respJson = await resp.json();
  const products: GiftProduct[] = (respJson.data?.products?.edges ?? []).map(
    (edge: { node: { id: string; title: string; status: string; featuredImage?: { url: string } } }) => ({
      id: edge.node.id,
      title: edge.node.title,
      status: edge.node.status,
      imageUrl: edge.node.featuredImage?.url ?? null,
    }),
  );

  return json({
    products,
    giftProductTag: GIFT_PRODUCT_TAG,
    tropetrainer: getTropeTrainerConnectionStatus(),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "add") {
    const raw = formData.get("productIds");
    const ids: string[] = typeof raw === "string" ? JSON.parse(raw) : [];
    for (const id of ids) {
      await addTag(admin, id, GIFT_PRODUCT_TAG);
    }
    return json({ ok: true });
  }

  if (intent === "remove") {
    const id = formData.get("productId");
    if (typeof id === "string") {
      await removeTag(admin, id, GIFT_PRODUCT_TAG);
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
};

export default function Settings() {
  const { products, giftProductTag, tropetrainer } = useLoaderData<typeof loader>();
  const addFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [openProduct, setOpenProduct] = useState<{ id: string; title: string } | null>(null);

  const openPicker = async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      action: "add",
      multiple: true,
      selectionIds: products.map((p) => ({ id: p.id })),
    });
    if (!selection || selection.length === 0) return;

    addFetcher.submit(
      {
        intent: "add",
        productIds: JSON.stringify(selection.map((p) => p.id)),
      },
      { method: "post" },
    );
  };

  return (
    <Page>
      <TitleBar title="Settings" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    TropeTrainer connection
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    The API credentials this app uses to request activation codes from
                    TropeTrainer. Configured via server environment variables — changing
                    them requires a deploy.
                  </Text>
                </BlockStack>
                <Divider />
                <InlineStack gap="600">
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">
                      API key
                    </Text>
                    <Badge tone={tropetrainer.apiKeyConfigured ? "success" : "critical"}>
                      {tropetrainer.apiKeyConfigured ? "Configured" : "Not configured"}
                    </Badge>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">
                      Endpoint
                    </Text>
                    <Badge tone={tropetrainer.isDefaultUrl ? "success" : "warning"}>
                      {tropetrainer.isDefaultUrl ? "Production" : "Non-default"}
                    </Badge>
                  </BlockStack>
                </InlineStack>
                <Text as="span" variant="bodySm" tone="subdued">
                  {tropetrainer.apiUrl}
                </Text>
                {!tropetrainer.isDefaultUrl && (
                  <Banner tone="warning">
                    This app is pointed at a non-production TropeTrainer endpoint.
                    Orders will not receive real activation codes until this is
                    corrected.
                  </Banner>
                )}
                {!tropetrainer.apiKeyConfigured && (
                  <Banner tone="critical">
                    No TropeTrainer API key is configured. Gift subscription orders will
                    fail until TROPETRAINER_API_KEY is set.
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <Card padding="0">
              <BlockStack gap="0">
                <Box padding="400">
                  <InlineStack align="space-between" blockAlign="start" gap="600" wrap={false}>
                    <Box maxWidth="760px">
                      <BlockStack gap="100">
                        <Text as="h2" variant="headingMd">
                          Gift subscription products
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Orders containing any of these products trigger a
                          TropeTrainer activation code. Adding or removing a product
                          here tags it with{" "}
                          <Text as="span" fontWeight="bold">
                            {giftProductTag}
                          </Text>
                          . You can also add or remove that tag directly on a
                          product in Shopify admin — it works the same either way.
                        </Text>
                      </BlockStack>
                    </Box>
                    <Box>
                      <Button variant="primary" onClick={openPicker}>
                        Add product
                      </Button>
                    </Box>
                  </InlineStack>
                </Box>
                <Divider />
                {products.length === 0 ? (
                  <Box padding="400">
                    <EmptyState
                      heading="No gift subscription products yet"
                      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    >
                      <p>Add the product that should trigger a TropeTrainer gift code.</p>
                    </EmptyState>
                  </Box>
                ) : (
                  <ResourceList
                    resourceName={{ singular: "product", plural: "products" }}
                    items={products}
                    renderItem={(product) => (
                      <ProductRow
                        key={product.id}
                        product={product}
                        onOpenProduct={setOpenProduct}
                      />
                    )}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
      {openProduct && (
        <ProductDetailsModal
          productId={openProduct.id}
          productTitle={openProduct.title}
          onClose={() => setOpenProduct(null)}
        />
      )}
    </Page>
  );
}

function ProductDetailsModal({
  productId,
  productTitle,
  onClose,
}: {
  productId: string;
  productTitle: string;
  onClose: () => void;
}) {
  const fetcher = useFetcher<{ product?: ProductDetails; error?: string }>();

  useEffect(() => {
    fetcher.load(`/app/product-details?id=${productId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  const product = fetcher.data?.product;
  const loading = fetcher.state !== "idle" && !fetcher.data;

  return (
    <Modal
      open
      onClose={onClose}
      title={productTitle}
      primaryAction={{
        content: "View in Shopify admin",
        url: `shopify:admin/products/${productId}`,
      }}
      secondaryActions={[{ content: "Close", onAction: onClose }]}
    >
      <Modal.Section>
        {loading ? (
          <SkeletonBodyText lines={6} />
        ) : product ? (
          <BlockStack gap="400">
            <InlineStack gap="600">
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Status
                </Text>
                <Badge tone={product.status === "ACTIVE" ? "success" : undefined}>
                  {product.status}
                </Badge>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Price range
                </Text>
                <Text as="span" fontWeight="medium">
                  {product.priceRangeMin === product.priceRangeMax
                    ? `${product.priceRangeMin} ${product.currency}`
                    : `${product.priceRangeMin}–${product.priceRangeMax} ${product.currency}`}
                </Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Inventory
                </Text>
                <Text as="span">{product.totalInventory}</Text>
              </BlockStack>
            </InlineStack>
            <InlineStack gap="600">
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Vendor
                </Text>
                <Text as="span">{product.vendor || "—"}</Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Type
                </Text>
                <Text as="span">{product.productType || "—"}</Text>
              </BlockStack>
            </InlineStack>
            {product.tags.length > 0 && (
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Tags
                </Text>
                <InlineStack gap="100">
                  {product.tags.map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </InlineStack>
              </BlockStack>
            )}
          </BlockStack>
        ) : (
          <Text as="p" tone="critical">
            Could not load product details.
          </Text>
        )}
      </Modal.Section>
    </Modal>
  );
}

function ProductRow({
  product,
  onOpenProduct,
}: {
  product: GiftProduct;
  onOpenProduct: (product: { id: string; title: string }) => void;
}) {
  const removeFetcher = useFetcher<typeof action>();
  const isRemoving = removeFetcher.state !== "idle";

  const numericProductId = product.id.replace("gid://shopify/Product/", "");

  return (
    <ResourceItem
      id={product.id}
      onClick={() => onOpenProduct({ id: numericProductId, title: product.title })}
      media={
        <Thumbnail
          source={product.imageUrl || ImageIcon}
          alt={product.title}
          size="small"
        />
      }
    >
      <InlineStack align="space-between" blockAlign="center">
        <BlockStack gap="050" inlineAlign="start">
          <Text as="span" variant="bodyMd" fontWeight="medium">
            {product.title}
          </Text>
          <Badge tone={product.status === "ACTIVE" ? "success" : undefined}>
            {product.status}
          </Badge>
        </BlockStack>
        <removeFetcher.Form method="post">
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="productId" value={product.id} />
          <Button size="slim" tone="critical" loading={isRemoving} submit>
            Remove
          </Button>
        </removeFetcher.Form>
      </InlineStack>
    </ResourceItem>
  );
}
