import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { html as htmlLang } from "@codemirror/lang-html";
import { css as cssLang } from "@codemirror/lang-css";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import { Page, Card, BlockStack, InlineStack, Text, Box, Icon, List, Tabs, Button, Badge } from "@shopify/polaris";
import { ClipboardIcon, CheckIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getInstantCertificateLinkParts } from "../certificate.server";
import {
  getVerifyWidgetSettings,
  saveVerifyWidgetHtml,
  saveVerifyWidgetCss,
  resetVerifyWidgetHtml,
  resetVerifyWidgetCss,
  DEFAULT_WIDGET_HTML,
  DEFAULT_WIDGET_CSS,
} from "../verify-widget.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { appUrl } = getInstantCertificateLinkParts(session.shop);
  const widget = await getVerifyWidgetSettings(session.shop);

  return json({
    appUrl,
    shop: session.shop,
    html: widget.html,
    css: widget.css,
    isHtmlCustom: widget.isHtmlCustom,
    isCssCustom: widget.isCssCustom,
  });
};

type ActionData = { ok: boolean; error?: string; html?: string; css?: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save-html") {
    const html = formData.get("html");
    if (typeof html !== "string" || !html.trim()) {
      return json<ActionData>({ ok: false, error: "HTML can't be empty" }, { status: 400 });
    }
    await saveVerifyWidgetHtml(session.shop, html);
    return json<ActionData>({ ok: true });
  }

  if (intent === "reset-html") {
    await resetVerifyWidgetHtml(session.shop);
    return json<ActionData>({ ok: true, html: DEFAULT_WIDGET_HTML });
  }

  if (intent === "save-css") {
    const css = formData.get("css");
    if (typeof css !== "string" || !css.trim()) {
      return json<ActionData>({ ok: false, error: "CSS can't be empty" }, { status: 400 });
    }
    await saveVerifyWidgetCss(session.shop, css);
    return json<ActionData>({ ok: true });
  }

  if (intent === "reset-css") {
    await resetVerifyWidgetCss(session.shop);
    return json<ActionData>({ ok: true, css: DEFAULT_WIDGET_CSS });
  }

  return json<ActionData>({ ok: false, error: "Unknown intent" }, { status: 400 });
};

function buildGlobalSnippet(appUrl: string, shop: string): string {
  const q = `?shop=${encodeURIComponent(shop)}`;
  return `<link rel="stylesheet" href="${appUrl}/verify-widget.css${q}">
<script src="${appUrl}/verify-widget.js${q}" defer></script>`;
}

const PLACEHOLDER_DIV = `<div id="ctaw-root"></div>`;

function CopyButton({ text, label }: { text: string; label: string }) {
  const shopify = useAppBridge();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      shopify.toast.show("Copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      shopify.toast.show("Couldn't copy to clipboard", { isError: true });
    }
  };

  return (
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
      {label}
      <Icon source={copied ? CheckIcon : ClipboardIcon} tone={copied ? "success" : "base"} />
    </button>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
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
        {children}
      </pre>
    </Box>
  );
}

export default function CodeLookup() {
  const { appUrl, shop, html, css, isHtmlCustom, isCssCustom } = useLoaderData<typeof loader>();
  const [selectedTab, setSelectedTab] = useState(0);

  const globalSnippet = useMemo(() => buildGlobalSnippet(appUrl, shop), [appUrl, shop]);

  const previewDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8">${globalSnippet}<style>body{margin:0;padding:32px 20px;background:#f6f6f7;}</style></head><body>${PLACEHOLDER_DIV}</body></html>`,
    [globalSnippet],
  );

  const tabs = [
    { id: "html", content: "HTML" },
    { id: "css", content: "CSS" },
    { id: "preview", content: "Preview" },
    { id: "setup", content: "Setup" },
  ];

  return (
    <Page>
      <TitleBar title="Code Lookup" />
      <BlockStack gap="500">
        <Text as="p" variant="bodySm" tone="subdued">
          Lets customers check whether a gift code has been redeemed, right from your store. The
          check happens live against TropeTrainer, so the result is always current.
        </Text>

        <Card padding="0">
          <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab} fitted>
            {selectedTab === 0 && (
              <Box padding="400">
                <CodeEditorTab
                  intent="html"
                  language="html"
                  value={html}
                  isCustom={isHtmlCustom}
                  note="Edit freely, but keep the class names and ids (ctaw-form, ctaw-input, ctaw-btn, ctaw-btn-text, ctaw-spinner, ctaw-result) — the widget's behavior is wired to them."
                />
              </Box>
            )}

            {selectedTab === 1 && (
              <Box padding="400">
                <CodeEditorTab
                  intent="css"
                  language="css"
                  value={css}
                  isCustom={isCssCustom}
                  note="Full control over styling — colors, spacing, fonts, everything."
                />
              </Box>
            )}

            {selectedTab === 2 && (
              <Box padding="400">
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
                  <Text as="p" variant="bodySm" tone="subdued">
                    Reflects your saved HTML and CSS — this is a real, live copy of what ships to
                    the storefront.
                  </Text>
                </BlockStack>
              </Box>
            )}

            {selectedTab === 3 && (
              <Box padding="400">
                <BlockStack gap="400">
                  <List type="number">
                    <List.Item>
                      Paste this once, sitewide — in your theme's{" "}
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        theme.liquid
                      </Text>{" "}
                      layout file, just before{" "}
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        {"</head>"}
                      </Text>
                      .
                    </List.Item>
                    <List.Item>
                      In Shopify admin, go to{" "}
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        Online Store → Pages
                      </Text>{" "}
                      and create a page, e.g. "Verify Your Gift Code".
                    </List.Item>
                    <List.Item>
                      Open the theme editor for that page, add a{" "}
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        Custom Liquid
                      </Text>{" "}
                      section, and paste just the placeholder div into it — nothing else.
                    </List.Item>
                  </List>

                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">
                        1. Paste once in theme.liquid
                      </Text>
                      <CopyButton text={globalSnippet} label="Copy" />
                    </InlineStack>
                    <CodeBlock>{globalSnippet}</CodeBlock>
                  </BlockStack>

                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">
                        2. Paste on the page where the widget should appear
                      </Text>
                      <CopyButton text={PLACEHOLDER_DIV} label="Copy" />
                    </InlineStack>
                    <CodeBlock>{PLACEHOLDER_DIV}</CodeBlock>
                  </BlockStack>
                </BlockStack>
              </Box>
            )}
          </Tabs>
        </Card>
      </BlockStack>
    </Page>
  );
}

function CodeEditorTab({
  intent,
  language,
  value,
  isCustom,
  note,
}: {
  intent: "html" | "css";
  language: "html" | "css";
  value: string;
  isCustom: boolean;
  note: string;
}) {
  const fetcher = useFetcher<ActionData>();
  const [code, setCode] = useState(value);
  const [savedCode, setSavedCode] = useState(value);
  const isSaving = fetcher.state !== "idle";
  const isDirty = code !== savedCode;
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok) return;
    if (pendingRef.current !== null) {
      setSavedCode(pendingRef.current);
      pendingRef.current = null;
    } else if (fetcher.data[intent] !== undefined) {
      const resetValue = fetcher.data[intent] as string;
      setCode(resetValue);
      setSavedCode(resetValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const handleSave = () => {
    pendingRef.current = code;
    fetcher.submit({ intent: `save-${intent}`, [intent]: code }, { method: "post" });
  };

  const handleReset = () => {
    fetcher.submit({ intent: `reset-${intent}` }, { method: "post" });
  };

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center">
        <InlineStack gap="200" blockAlign="center">
          <Badge tone={isCustom ? "attention" : "success"}>{isCustom ? "Customized" : "Default"}</Badge>
          {isDirty && <Badge tone="attention">Unsaved changes</Badge>}
        </InlineStack>
        <InlineStack gap="200">
          <Button onClick={handleReset} disabled={isSaving}>
            Reset to default
          </Button>
          <Button variant="primary" onClick={handleSave} loading={isSaving} disabled={!isDirty || isSaving}>
            Save
          </Button>
        </InlineStack>
      </InlineStack>

      {fetcher.data?.error && <Text as="p" tone="critical">{fetcher.data.error}</Text>}

      <Text as="p" variant="bodySm" tone="subdued">
        {note}
      </Text>

      <CodeMirror
        value={code}
        onChange={setCode}
        height="420px"
        theme={vscodeDark}
        extensions={[language === "html" ? htmlLang() : cssLang()]}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
        }}
        style={{ fontSize: "13px" }}
      />
    </BlockStack>
  );
}
