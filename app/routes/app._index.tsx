import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useSubmit } from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  InlineStack,
  IndexTable,
  Badge,
  EmptyState,
  Tooltip,
  Box,
  Banner,
  Pagination,
  List,
  Filters,
  ChoiceList,
  Modal,
  SkeletonBodyText,
  Divider,
} from "@shopify/polaris";
import { ClipboardIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { attemptIssueCode, hasAnyGiftProduct } from "../gift-order.server";
import { getTropeTrainerConnectionStatus } from "../tropetrainer.server";
import type { OrderDetails } from "./app.order-details";

const PAGE_SIZE = 20;
const STATUS_LABELS: Record<string, string> = {
  issued: "Issued",
  failed: "Failed",
  pending: "Pending",
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type LoaderGiftCode = {
  id: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  status: string;
  code: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  recipient: string | null;
  giver: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  const q = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const where = {
    ...(status !== "all" ? { status } : {}),
    ...(q ? { shopifyOrderName: { contains: q } } : {}),
  };

  const [records, totalCount, issuedCount, failedCount, pendingCount, tropetrainer, hasGiftProduct] =
    await Promise.all([
      db.giftCode.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      db.giftCode.count({ where }),
      db.giftCode.count({ where: { status: "issued" } }),
      db.giftCode.count({ where: { status: "failed" } }),
      db.giftCode.count({ where: { status: "pending" } }),
      Promise.resolve(getTropeTrainerConnectionStatus()),
      hasAnyGiftProduct(admin),
    ]);

  const detailsByOrderId: Record<string, { recipient?: string; giver?: string }> = {};
  if (records.length > 0) {
    const orderGids = records.map((r) => `gid://shopify/Order/${r.shopifyOrderId}`);
    const resp = await admin.graphql(
      `#graphql
      query GiftOrderDetails($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            lineItems(first: 5) {
              edges { node { customAttributes { key value } } }
            }
          }
        }
      }`,
      { variables: { ids: orderGids } },
    );
    const respJson = await resp.json();
    for (const node of respJson.data?.nodes ?? []) {
      if (!node) continue;
      const numericId = node.id.replace("gid://shopify/Order/", "");
      const attrs: { key: string; value: string }[] = node.lineItems.edges.flatMap(
        (e: { node: { customAttributes: { key: string; value: string }[] } }) =>
          e.node.customAttributes,
      );
      detailsByOrderId[numericId] = {
        recipient: attrs.find((a) => a.key === "Recipient name")?.value,
        giver: attrs.find((a) => a.key === "Gift giver name")?.value,
      };
    }
  }

  return json({
    records: records.map((r) => ({
      id: r.id,
      shopifyOrderId: r.shopifyOrderId,
      shopifyOrderName: r.shopifyOrderName,
      status: r.status,
      code: r.code,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt.toISOString(),
      recipient: detailsByOrderId[r.shopifyOrderId]?.recipient ?? null,
      giver: detailsByOrderId[r.shopifyOrderId]?.giver ?? null,
    })) satisfies LoaderGiftCode[],
    totalCount,
    page,
    pageSize: PAGE_SIZE,
    filters: { status, q },
    stats: { issuedCount, failedCount, pendingCount },
    setup: {
      apiKeyConfigured: tropetrainer.apiKeyConfigured,
      hasGiftProduct,
    },
  });
};

type ActionData = { ok: boolean; error?: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const id = formData.get("id");
  if (typeof id !== "string") {
    return json<ActionData>({ ok: false, error: "Missing id" }, { status: 400 });
  }
  const record = await db.giftCode.findUnique({ where: { id } });
  if (!record) {
    return json<ActionData>({ ok: false, error: "Not found" }, { status: 404 });
  }
  const result = await attemptIssueCode({
    admin,
    shop: session.shop,
    orderGid: `gid://shopify/Order/${record.shopifyOrderId}`,
    shopifyOrderId: record.shopifyOrderId,
    shopifyOrderName: record.shopifyOrderName,
    idempotencyKey: record.idempotencyKey,
  });
  return json<ActionData>({ ok: result.ok });
};

function StatusBadge({ status }: { status: string }) {
  if (status === "issued") return <Badge tone="success">Issued</Badge>;
  if (status === "failed") return <Badge tone="critical">Failed</Badge>;
  return <Badge tone="attention">Pending</Badge>;
}

function OrderDetailsModal({
  orderId,
  orderName,
  onClose,
}: {
  orderId: string;
  orderName: string;
  onClose: () => void;
}) {
  const fetcher = useFetcher<{ order?: OrderDetails; error?: string }>();

  useEffect(() => {
    fetcher.load(`/app/order-details?id=${orderId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  const order = fetcher.data?.order;
  const loading = fetcher.state !== "idle" && !fetcher.data;

  return (
    <Modal
      open
      onClose={onClose}
      title={orderName}
      primaryAction={{
        content: "View in Shopify admin",
        url: `shopify:admin/orders/${orderId}`,
      }}
      secondaryActions={[{ content: "Close", onAction: onClose }]}
    >
      <Modal.Section>
        {loading ? (
          <SkeletonBodyText lines={8} />
        ) : order ? (
          <BlockStack gap="400">
            <BlockStack gap="050">
              <Text as="span" variant="bodySm" tone="subdued">
                Customer
              </Text>
              <Text as="span" fontWeight="medium">
                {order.customerName ?? "—"}
              </Text>
              {order.customerEmail && (
                <Text as="span" variant="bodySm" tone="subdued">
                  {order.customerEmail}
                </Text>
              )}
            </BlockStack>

            <InlineStack gap="600">
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Order date
                </Text>
                <Text as="span">{new Date(order.createdAt).toLocaleString()}</Text>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Total
                </Text>
                <Text as="span" fontWeight="medium">
                  {order.totalPrice} {order.currency}
                </Text>
              </BlockStack>
            </InlineStack>

            <InlineStack gap="600">
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Payment
                </Text>
                <Badge>{order.financialStatus}</Badge>
              </BlockStack>
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Fulfillment
                </Text>
                <Badge>{order.fulfillmentStatus}</Badge>
              </BlockStack>
            </InlineStack>

            {order.shippingAddress && (
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Shipping address
                </Text>
                <Text as="span">
                  {order.shippingAddress.split("\n").map((line, i) => (
                    <span key={i}>
                      {line}
                      <br />
                    </span>
                  ))}
                </Text>
              </BlockStack>
            )}

            {order.tags.length > 0 && (
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">
                  Tags
                </Text>
                <InlineStack gap="100">
                  {order.tags.map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </InlineStack>
              </BlockStack>
            )}

            <Divider />
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Line items
              </Text>
              {order.lineItems.map((item, i) => (
                <InlineStack key={i} align="space-between">
                  <Text as="span">
                    {item.title} × {item.quantity}
                  </Text>
                  <Text as="span" tone="subdued">
                    {item.price} {order.currency}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          </BlockStack>
        ) : (
          <Text as="p" tone="critical">
            Could not load order details.
          </Text>
        )}
      </Modal.Section>
    </Modal>
  );
}

function GiftCodeRow({
  record,
  index,
  onOpenOrder,
}: {
  record: LoaderGiftCode;
  index: number;
  onOpenOrder: (order: { id: string; name: string }) => void;
}) {
  const retryFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isRetrying = retryFetcher.state !== "idle";

  const copyCode = () => {
    if (!record.code) return;
    navigator.clipboard.writeText(record.code);
    shopify.toast.show("Code copied");
  };

  return (
    <IndexTable.Row id={record.id} position={index}>
      <IndexTable.Cell>
        <Button
          variant="plain"
          onClick={() =>
            onOpenOrder({ id: record.shopifyOrderId, name: record.shopifyOrderName })
          }
        >
          {record.shopifyOrderName}
        </Button>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack gap="050">
          <Text as="span" variant="bodySm">
            {record.giver ? `From: ${record.giver}` : "—"}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {record.recipient ? `To: ${record.recipient}` : ""}
          </Text>
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <StatusBadge status={record.status} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        {record.code ? (
          <InlineStack gap="100" blockAlign="center" wrap={false}>
            <Text as="span" variant="bodyMd" fontWeight="medium">
              {record.code}
            </Text>
            <Button
              icon={ClipboardIcon}
              variant="tertiary"
              accessibilityLabel="Copy code"
              onClick={copyCode}
            />
          </InlineStack>
        ) : record.status === "failed" && record.errorMessage ? (
          <Tooltip content={record.errorMessage}>
            <Text as="span" variant="bodySm" tone="critical">
              {truncate(record.errorMessage, 40)}
            </Text>
          </Tooltip>
        ) : (
          <Text as="span" tone="subdued">
            —
          </Text>
        )}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm" tone="subdued">
          {new Date(record.createdAt).toLocaleString()}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {record.status === "failed" && (
          <retryFetcher.Form method="post">
            <input type="hidden" name="id" value={record.id} />
            <Button size="slim" loading={isRetrying} submit>
              Retry
            </Button>
          </retryFetcher.Form>
        )}
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}

function SetupBanner({ setup }: { setup: { apiKeyConfigured: boolean; hasGiftProduct: boolean } }) {
  const missing: string[] = [];
  if (!setup.apiKeyConfigured) missing.push("TropeTrainer API key is not configured");
  if (!setup.hasGiftProduct) missing.push("No product is tagged as a gift subscription");

  if (missing.length === 0) return null;

  return (
    <Banner
      tone="warning"
      title={`Setup incomplete: ${missing.length} step${missing.length > 1 ? "s" : ""} left`}
    >
      <BlockStack gap="200">
        <List>
          {missing.map((item) => (
            <List.Item key={item}>{item}</List.Item>
          ))}
        </List>
        <Box>
          <Button url="/app/settings" variant="plain">
            Go to Settings
          </Button>
        </Box>
      </BlockStack>
    </Banner>
  );
}

function OrderFilters({ filters }: { filters: { status: string; q: string } }) {
  const submit = useSubmit();
  const [queryValue, setQueryValue] = useState(filters.q);
  const [statusValue, setStatusValue] = useState<string[]>(
    filters.status === "all" ? [] : [filters.status],
  );

  const navigate = (next: { status?: string; q?: string }) => {
    const params = new URLSearchParams();
    const nextStatus = next.status ?? statusValue[0] ?? "all";
    const nextQ = next.q ?? queryValue;
    if (nextStatus !== "all") params.set("status", nextStatus);
    if (nextQ) params.set("q", nextQ);
    submit(params, { method: "get" });
  };

  useEffect(() => {
    const handle = setTimeout(() => {
      if (queryValue !== filters.q) navigate({ q: queryValue });
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryValue]);

  return (
    <Filters
      queryValue={queryValue}
      queryPlaceholder="Search order number"
      onQueryChange={setQueryValue}
      onQueryClear={() => {
        setQueryValue("");
        navigate({ q: "" });
      }}
      onClearAll={() => {
        setQueryValue("");
        setStatusValue([]);
        navigate({ q: "", status: "all" });
      }}
      filters={[
        {
          key: "status",
          label: "Status",
          shortcut: true,
          filter: (
            <ChoiceList
              title="Status"
              titleHidden
              choices={[
                { label: "Issued", value: "issued" },
                { label: "Failed", value: "failed" },
                { label: "Pending", value: "pending" },
              ]}
              selected={statusValue}
              onChange={(value) => {
                setStatusValue(value);
                navigate({ status: value[0] ?? "all" });
              }}
            />
          ),
        },
      ]}
      appliedFilters={
        statusValue.length > 0
          ? [
              {
                key: "status",
                label: `Status: ${STATUS_LABELS[statusValue[0]]}`,
                onRemove: () => {
                  setStatusValue([]);
                  navigate({ status: "all" });
                },
              },
            ]
          : []
      }
    />
  );
}

export default function Index() {
  const { records, totalCount, page, pageSize, filters, stats, setup } =
    useLoaderData<typeof loader>();
  const [openOrder, setOpenOrder] = useState<{ id: string; name: string } | null>(null);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <Page>
      <TitleBar title="Gift Subscription Codes" />
      <BlockStack gap="500">
        <SetupBanner setup={setup} />
        <Layout>
          <Layout.Section>
            <InlineStack gap="400">
              <Box minWidth="150px">
                <Card>
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">
                      Issued
                    </Text>
                    <Text as="span" variant="headingLg">
                      {stats.issuedCount}
                    </Text>
                  </BlockStack>
                </Card>
              </Box>
              <Box minWidth="150px">
                <Card>
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">
                      Failed
                    </Text>
                    <Text as="span" variant="headingLg" tone="critical">
                      {stats.failedCount}
                    </Text>
                  </BlockStack>
                </Card>
              </Box>
              <Box minWidth="150px">
                <Card>
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">
                      Pending
                    </Text>
                    <Text as="span" variant="headingLg">
                      {stats.pendingCount}
                    </Text>
                  </BlockStack>
                </Card>
              </Box>
            </InlineStack>
          </Layout.Section>

          <Layout.Section>
            <Card padding="0">
              <OrderFilters filters={filters} />
              {records.length === 0 ? (
                <Box padding="400">
                  <EmptyState
                    heading="No gift subscription orders found"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>
                      {filters.status !== "all" || filters.q
                        ? "Try clearing the filters."
                        : "Orders for the gift subscription product will appear here once a customer checks out."}
                    </p>
                  </EmptyState>
                </Box>
              ) : (
                <>
                  <IndexTable
                    resourceName={{ singular: "gift code", plural: "gift codes" }}
                    itemCount={records.length}
                    selectable={false}
                    headings={[
                      { title: "Order" },
                      { title: "Recipient / Giver" },
                      { title: "Status" },
                      { title: "Code / Reason" },
                      { title: "Created" },
                      { title: "" },
                    ]}
                  >
                    {records.map((record, index) => (
                      <GiftCodeRow
                        record={record}
                        index={index}
                        key={record.id}
                        onOpenOrder={setOpenOrder}
                      />
                    ))}
                  </IndexTable>
                  <Box padding="400">
                    <InlineStack align="center">
                      <Pagination
                        hasPrevious={page > 1}
                        previousURL={`/app?status=${filters.status}&q=${filters.q}&page=${page - 1}`}
                        hasNext={page < totalPages}
                        nextURL={`/app?status=${filters.status}&q=${filters.q}&page=${page + 1}`}
                        label={`Page ${page} of ${totalPages}`}
                      />
                    </InlineStack>
                  </Box>
                </>
              )}
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
      {openOrder && (
        <OrderDetailsModal
          orderId={openOrder.id}
          orderName={openOrder.name}
          onClose={() => setOpenOrder(null)}
        />
      )}
    </Page>
  );
}
