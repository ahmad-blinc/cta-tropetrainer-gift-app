import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useMemo, useState } from "react";
import { Page, Layout, Card, BlockStack, InlineStack, Text, Box, Icon, List } from "@shopify/polaris";
import { ClipboardIcon, CheckIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getInstantCertificateLinkParts } from "../certificate.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { appUrl } = getInstantCertificateLinkParts(session.shop);
  return json({ appUrl });
};

// The widget itself (HTML structure, CSS and behavior) is hosted at
// /verify-widget.css and /verify-widget.js — this app serves them as static
// files. The theme only needs the empty placeholder div plus these two
// tags, so a future design or behavior change ships automatically without
// ever having to re-paste anything into the theme.
function buildEmbedSnippet(appUrl: string): string {
  return `<div id="ctaw-root"></div>
<link rel="stylesheet" href="${appUrl}/verify-widget.css">
<script src="${appUrl}/verify-widget.js" defer></script>`;
}

export default function CodeLookup() {
  const { appUrl } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const [copied, setCopied] = useState(false);
  const snippet = useMemo(() => buildEmbedSnippet(appUrl), [appUrl]);

  const previewDoc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:32px 20px;background:#f6f6f7;}</style></head><body>${snippet}</body></html>`,
    [snippet],
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      shopify.toast.show("Snippet copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      shopify.toast.show("Couldn't copy to clipboard", { isError: true });
    }
  };

  return (
    <Page>
      <TitleBar title="Code Lookup" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Text as="p" variant="bodySm" tone="subdued">
              Lets customers check whether a gift code has been redeemed, right from your store.
              The check happens live against TropeTrainer, so the result is always current.
            </Text>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingSm">
                  Live preview
                </Text>
                <Box borderRadius="200" overflowX="hidden" background="bg-surface-secondary">
                  <iframe
                    title="Code lookup widget preview"
                    srcDoc={previewDoc}
                    style={{ width: "100%", height: "260px", border: "none", display: "block" }}
                  />
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingSm">
                    Embed code
                  </Text>
                  <button
                    type="button"
                    onClick={handleCopy}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "6px 10px",
                      background: "#ffffff",
                      border: "1px solid #c9cccf",
                      borderRadius: "6px",
                      cursor: "pointer",
                      fontSize: "13px",
                    }}
                  >
                    Copy snippet
                    <Icon source={copied ? CheckIcon : ClipboardIcon} tone={copied ? "success" : "base"} />
                  </button>
                </InlineStack>
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                      fontSize: "12.5px",
                      lineHeight: 1.6,
                    }}
                  >
                    {snippet}
                  </pre>
                </Box>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingSm">
                Setup
              </Text>
              <List type="number">
                <List.Item>
                  In Shopify admin, go to{" "}
                  <Text as="span" variant="bodySm" fontWeight="medium">
                    Online Store → Pages
                  </Text>{" "}
                  and create a page, e.g. "Verify Your Gift Code".
                </List.Item>
                <List.Item>
                  Open the theme editor for that page and add a{" "}
                  <Text as="span" variant="bodySm" fontWeight="medium">
                    Custom Liquid
                  </Text>{" "}
                  section.
                </List.Item>
                <List.Item>Paste the embed code from the left into that section.</List.Item>
                <List.Item>Save — the page is live immediately.</List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
