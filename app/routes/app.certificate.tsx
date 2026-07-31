import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import Mustache from "mustache";
import CodeMirror from "@uiw/react-codemirror";
import { html as htmlLang } from "@codemirror/lang-html";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Box,
  Banner,
  Badge,
  Tabs,
  ButtonGroup,
  DropZone,
  Thumbnail,
  Icon,
  TextField,
} from "@shopify/polaris";
import { ClipboardIcon, CheckIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getCertificateTemplate,
  saveCertificateTemplate,
  resetCertificateTemplate,
  DEFAULT_CERTIFICATE_TEMPLATE,
  SAMPLE_CERTIFICATE_DATA,
  CERTIFICATE_VARIABLES,
  getInstantCertificateLinkParts,
} from "../certificate.server";
import {
  CERTIFICATE_ASSET_KEYS,
  CERTIFICATE_ASSET_LABELS,
  type CertificateAssetKey,
  getCertificateAssetUrls,
  getCertificateAssetOverrideKeys,
  getDefaultAssetUrl,
  uploadCertificateAsset,
  resetCertificateAsset,
} from "../certificate-assets.server";
import { getCertificateEmailSettings, saveCertificateEmailSettings } from "../certificate-email.server";
import {
  getCertificateStatusMessages,
  saveCertificateStatusMessages,
  DEFAULT_STATUS_MESSAGES,
  type CertificateStatusMessages,
} from "../certificate-status.server";
import { GIFT_PRODUCT_TAG } from "../gift-order.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [template, customRecord, assetUrls, overrideKeys, emailSettings, statusMessages] =
    await Promise.all([
      getCertificateTemplate(session.shop),
      db.certificateTemplate.findUnique({ where: { shop: session.shop } }),
      getCertificateAssetUrls(session.shop),
      getCertificateAssetOverrideKeys(session.shop),
      getCertificateEmailSettings(session.shop),
      getCertificateStatusMessages(session.shop),
    ]);

  // Built server-side so the component never has to import the .server-only
  // asset constants itself (that would pull db.server into the client bundle).
  const assetRows = CERTIFICATE_ASSET_KEYS.map((key) => ({
    key,
    label: CERTIFICATE_ASSET_LABELS[key],
    url: assetUrls[key],
    isCustom: overrideKeys.has(key),
  }));

  return json({
    template,
    isCustom: !!customRecord,
    defaultTemplate: DEFAULT_CERTIFICATE_TEMPLATE,
    // Reflects this shop's actual current logos (custom or default) so the
    // editor's live preview matches what real certificates will look like.
    sampleData: {
      ...SAMPLE_CERTIFICATE_DATA,
      sealImageUrl: assetUrls.seal,
      tropetrainerLogoUrl: assetUrls.tropetrainerLogo,
      cantorsLogoUrl: assetUrls.cantorsLogo,
    },
    variables: CERTIFICATE_VARIABLES,
    assetRows,
    emailSettings,
    certificateLinkParts: getInstantCertificateLinkParts(session.shop),
    giftProductTag: GIFT_PRODUCT_TAG,
    statusMessages,
    defaultStatusMessages: DEFAULT_STATUS_MESSAGES,
  });
};

type ActionData = {
  ok: boolean;
  error?: string;
  template?: string;
  assetKey?: CertificateAssetKey;
  assetUrl?: string;
  emailSettings?: boolean;
  statusMessages?: boolean;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "save") {
    const html = formData.get("html");
    if (typeof html !== "string" || !html.trim()) {
      return json<ActionData>({ ok: false, error: "Template can't be empty" }, { status: 400 });
    }
    try {
      Mustache.parse(html);
    } catch (err) {
      return json<ActionData>(
        { ok: false, error: `Invalid template syntax: ${(err as Error).message}` },
        { status: 400 },
      );
    }
    await saveCertificateTemplate(session.shop, html);
    return json<ActionData>({ ok: true });
  }

  if (intent === "reset") {
    await resetCertificateTemplate(session.shop);
    return json<ActionData>({ ok: true, template: DEFAULT_CERTIFICATE_TEMPLATE });
  }

  if (intent === "upload-asset") {
    const key = formData.get("key");
    const file = formData.get("file");
    if (typeof key !== "string" || !CERTIFICATE_ASSET_KEYS.includes(key as CertificateAssetKey)) {
      return json<ActionData>({ ok: false, error: "Unknown asset" }, { status: 400 });
    }
    if (!(file instanceof File) || file.size === 0) {
      return json<ActionData>(
        { ok: false, error: "Choose an image to upload", assetKey: key as CertificateAssetKey },
        { status: 400 },
      );
    }
    try {
      const url = await uploadCertificateAsset(admin, session.shop, key as CertificateAssetKey, file);
      return json<ActionData>({ ok: true, assetKey: key as CertificateAssetKey, assetUrl: url });
    } catch (err) {
      return json<ActionData>(
        { ok: false, error: (err as Error).message, assetKey: key as CertificateAssetKey },
        { status: 500 },
      );
    }
  }

  if (intent === "reset-asset") {
    const key = formData.get("key");
    if (typeof key !== "string" || !CERTIFICATE_ASSET_KEYS.includes(key as CertificateAssetKey)) {
      return json<ActionData>({ ok: false, error: "Unknown asset" }, { status: 400 });
    }
    await resetCertificateAsset(session.shop, key as CertificateAssetKey);
    return json<ActionData>({
      ok: true,
      assetKey: key as CertificateAssetKey,
      assetUrl: getDefaultAssetUrl(key as CertificateAssetKey),
    });
  }

  if (intent === "save-email-settings") {
    const headingText = formData.get("headingText");
    const linkText = formData.get("linkText");
    if (typeof linkText !== "string" || !linkText.trim()) {
      return json<ActionData>(
        { ok: false, error: "Link text can't be empty", emailSettings: true },
        { status: 400 },
      );
    }
    await saveCertificateEmailSettings(session.shop, {
      headingText: typeof headingText === "string" ? headingText.trim() : "",
      linkText: linkText.trim(),
    });
    return json<ActionData>({ ok: true, emailSettings: true });
  }

  if (intent === "save-status-messages") {
    const requiredFields = [
      "processingHeading",
      "processingBody",
      "delayedHeading",
      "delayedBody",
    ] as const;
    const values: Partial<CertificateStatusMessages> = {};
    for (const field of requiredFields) {
      const value = formData.get(field);
      if (typeof value !== "string" || !value.trim()) {
        return json<ActionData>(
          { ok: false, error: "All fields are required", statusMessages: true },
          { status: 400 },
        );
      }
      values[field] = value.trim();
    }
    const contactLink = formData.get("contactLink");
    values.contactLink = typeof contactLink === "string" ? contactLink.trim() : "";
    const visibility = formData.get("contactLinkVisibility");
    values.contactLinkVisibility =
      visibility === "processing" || visibility === "both" ? visibility : "delayed";
    await saveCertificateStatusMessages(session.shop, values as CertificateStatusMessages);
    return json<ActionData>({ ok: true, statusMessages: true });
  }

  return json<ActionData>({ ok: false, error: "Unknown intent" }, { status: 400 });
};

const PANEL_HEIGHT = "68vh";
// Letter page at 96dpi — matches the dimensions generateCertificatePdf renders with
// Puppeteer (`page.pdf({ format: "Letter" })`), so the preview matches the real PDF.
const PAGE_WIDTH = 816;
const PAGE_HEIGHT = 1056;

export default function CertificateDesign() {
  const {
    template,
    isCustom,
    defaultTemplate,
    sampleData,
    variables,
    assetRows,
    emailSettings,
    certificateLinkParts,
    giftProductTag,
    statusMessages,
    defaultStatusMessages,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [code, setCode] = useState(template);
  const [savedCode, setSavedCode] = useState(template);
  const [selectedTab, setSelectedTab] = useState(0);
  const [editorFullWidth, setEditorFullWidth] = useState(false);
  const [editorTheme, setEditorTheme] = useState<"dark" | "light">("dark");
  const isSaving = fetcher.state !== "idle";
  const isDirty = code !== savedCode;
  const pendingSavedCodeRef = useRef<string | null>(null);

  const preview = useMemo(() => {
    try {
      return { html: Mustache.render(code, sampleData), error: null as string | null };
    } catch (err) {
      return { html: "", error: (err as Error).message };
    }
  }, [code, sampleData]);

  const handleCodeChange = useCallback((value: string) => setCode(value), []);

  const handleSave = () => {
    pendingSavedCodeRef.current = code;
    fetcher.submit({ intent: "save", html: code }, { method: "post" });
  };

  const handleReset = () => {
    setCode(defaultTemplate);
    fetcher.submit({ intent: "reset" }, { method: "post" });
  };

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok) return;
    const intent = (fetcher.formData as FormData | undefined)?.get("intent");
    if (intent === "save" && pendingSavedCodeRef.current !== null) {
      setSavedCode(pendingSavedCodeRef.current);
      pendingSavedCodeRef.current = null;
    } else if (intent === "reset") {
      setSavedCode(defaultTemplate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const tabs = [
    { id: "code", content: "Code" },
    { id: "preview", content: "Preview" },
    { id: "variables", content: "Available variables" },
    { id: "assets", content: "Brand assets" },
    { id: "email", content: "Email link" },
    { id: "waiting", content: "Waiting page" },
  ];

  const fullBleedStyle: CSSProperties | undefined =
    selectedTab === 0 && editorFullWidth
      ? {
          width: "100vw",
          position: "relative",
          left: "50%",
          right: "50%",
          marginLeft: "-50vw",
          marginRight: "-50vw",
        }
      : undefined;

  return (
    <Page>
      <TitleBar title="Certificate" />
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="bodySm" tone="subdued">
              Status:
            </Text>
            <Badge tone={isCustom ? "attention" : "success"}>
              {isCustom ? "Customized" : "Default design"}
            </Badge>
            {selectedTab === 0 && isDirty && <Badge tone="attention">Unsaved changes</Badge>}
          </InlineStack>

          {selectedTab === 0 && (
            <InlineStack gap="300" blockAlign="center">
              <ButtonGroup variant="segmented">
                <Button
                  size="slim"
                  pressed={editorTheme === "dark"}
                  onClick={() => setEditorTheme("dark")}
                >
                  Dark
                </Button>
                <Button
                  size="slim"
                  pressed={editorTheme === "light"}
                  onClick={() => setEditorTheme("light")}
                >
                  Light
                </Button>
              </ButtonGroup>
              <Button size="slim" onClick={() => setEditorFullWidth((w) => !w)}>
                {editorFullWidth ? "Standard width" : "Full width editor"}
              </Button>
              <Button onClick={handleReset} disabled={isSaving}>
                Reset to default
              </Button>
              <Button
                variant="primary"
                onClick={handleSave}
                loading={isSaving}
                disabled={!isDirty || isSaving}
              >
                Save
              </Button>
            </InlineStack>
          )}
        </InlineStack>

        {fetcher.data?.error && !fetcher.data.assetKey && (
          <Banner tone="critical">{fetcher.data.error}</Banner>
        )}
        {fetcher.data?.ok && !fetcher.data.error && !fetcher.data.assetKey && (
          <Banner tone="success">Saved. New certificates will use this design.</Banner>
        )}

        <div style={fullBleedStyle}>
          <Card padding="0">
            <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab} fitted>
              {selectedTab === 0 && (
                <Box>
                  <CodeMirror
                    value={code}
                    onChange={handleCodeChange}
                    height={PANEL_HEIGHT}
                    theme={editorTheme === "dark" ? vscodeDark : vscodeLight}
                    extensions={[htmlLang()]}
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
                </Box>
              )}

              {selectedTab === 1 &&
                (preview.error ? (
                  <Box padding="400">
                    <Banner tone="critical">{`Template error: ${preview.error}`}</Banner>
                  </Box>
                ) : (
                  <CertificatePagePreview html={preview.html} />
                ))}

              {selectedTab === 2 && (
                <Box padding="400">
                  <VariablesTab variables={variables} />
                </Box>
              )}

              {selectedTab === 3 && (
                <Box padding="400">
                  <BlockStack gap="400">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Replace any of these images without a code change — the default design
                      references them as{" "}
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        {"{{sealImageUrl}}"}
                      </Text>
                      ,{" "}
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        {"{{tropetrainerLogoUrl}}"}
                      </Text>{" "}
                      and{" "}
                      <Text as="span" variant="bodySm" fontWeight="medium">
                        {"{{cantorsLogoUrl}}"}
                      </Text>
                      .
                    </Text>
                    {assetRows.map((row) => (
                      <AssetUploadRow
                        key={row.key}
                        assetKey={row.key}
                        label={row.label}
                        url={row.url}
                        isCustom={row.isCustom}
                      />
                    ))}
                  </BlockStack>
                </Box>
              )}

              {selectedTab === 4 && (
                <Box padding="400">
                  <EmailLinkTab
                    initialSettings={emailSettings}
                    linkParts={certificateLinkParts}
                    giftProductTag={giftProductTag}
                  />
                </Box>
              )}

              {selectedTab === 5 && (
                <Box padding="400">
                  <WaitingPageTab initialMessages={statusMessages} defaultMessages={defaultStatusMessages} />
                </Box>
              )}
            </Tabs>
          </Card>
        </div>
      </BlockStack>
    </Page>
  );
}

const DEFAULT_EMAIL_LINK_TEXT_CLIENT = "Download Your Gift Certificate";

type CertificateLinkParts = { appUrl: string; shop: string; key: string };

// Builds the certificate link from {{ order.id }} directly, the same way
// Order Printer Pro's own snippet does — every piece of the URL is data
// Shopify's Liquid already has the instant the email is composed, so the
// link always appears, with no dependency on our webhook having run yet
// (unlike the old version, which pulled from a metafield our webhook writes
// asynchronously and could still be empty when the email actually sends).
//
// Gated on the *product's* tag, not the order's — order tags are added by
// our webhook (same race condition all over again), but product tags are
// static and available to Liquid instantly, so this correctly limits the
// block to orders that actually contain a gift-subscription product instead
// of showing on every order confirmation email.
function buildEmailSnippet(
  headingText: string,
  linkText: string,
  linkParts: CertificateLinkParts,
  giftProductTag: string,
): string {
  const heading = headingText.trim();
  const link = linkText.trim() || DEFAULT_EMAIL_LINK_TEXT_CLIENT;
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const headingHtml = heading
    ? `\n    <strong style="display: block; margin-bottom: 6px;">${escape(heading)}</strong>`
    : "";
  const href = `${linkParts.appUrl}/certificate/{{ order.id }}?shop=${encodeURIComponent(linkParts.shop)}&key=${linkParts.key}`;

  return `{% assign show_gift_certificate = false %}
{% for line in line_items %}
  {% if line.product.tags contains '${giftProductTag}' %}
    {% assign show_gift_certificate = true %}
  {% endif %}
{% endfor %}
{% if show_gift_certificate %}
<p style="margin: 24px 0 0; text-align: center; font-family: Arial, sans-serif;">${headingHtml}
    <a href="${href}" style="color: #2c6ecb; text-decoration: underline;">${escape(link)}</a>
</p>
{% endif %}`;
}

const DEFAULT_EMAIL_SETTINGS = { headingText: "", linkText: DEFAULT_EMAIL_LINK_TEXT_CLIENT };

function EmailLinkTab({
  initialSettings,
  linkParts,
  giftProductTag,
}: {
  initialSettings: { headingText: string; linkText: string };
  linkParts: CertificateLinkParts;
  giftProductTag: string;
}) {
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();
  const [headingText, setHeadingText] = useState(initialSettings.headingText);
  const [linkText, setLinkText] = useState(initialSettings.linkText);
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [copied, setCopied] = useState(false);
  const isSaving = fetcher.state !== "idle";
  const isDirty = headingText !== savedSettings.headingText || linkText !== savedSettings.linkText;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok || !fetcher.data.emailSettings) return;
    const submitted = fetcher.formData as FormData | undefined;
    const savedHeading = (submitted?.get("headingText") as string | null) ?? "";
    const savedLink = (submitted?.get("linkText") as string | null) ?? DEFAULT_EMAIL_LINK_TEXT_CLIENT;
    setSavedSettings({ headingText: savedHeading, linkText: savedLink });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const submitSettings = (settings: { headingText: string; linkText: string }) => {
    fetcher.submit(
      { intent: "save-email-settings", headingText: settings.headingText, linkText: settings.linkText },
      { method: "post" },
    );
  };

  const handleSave = () => submitSettings({ headingText, linkText });

  const handleReset = () => {
    setHeadingText(DEFAULT_EMAIL_SETTINGS.headingText);
    setLinkText(DEFAULT_EMAIL_SETTINGS.linkText);
    submitSettings(DEFAULT_EMAIL_SETTINGS);
  };

  const snippet = useMemo(
    () => buildEmailSnippet(headingText, linkText, linkParts, giftProductTag),
    [headingText, linkText, linkParts, giftProductTag],
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

  const error =
    fetcher.data && !fetcher.data.ok && fetcher.data.emailSettings ? fetcher.data.error : null;
  const isDefault = !headingText && linkText === DEFAULT_EMAIL_SETTINGS.linkText;

  return (
    <BlockStack gap="400">
      <Text as="p" variant="bodySm" tone="subdued">
        Add a link to the certificate PDF in your order confirmation email. Configure the text
        below, then paste the generated snippet into{" "}
        <Text as="span" variant="bodySm" fontWeight="medium">
          Settings → Notifications → Order confirmation
        </Text>{" "}
        in Shopify admin.
      </Text>

      {error && <Banner tone="critical">{error}</Banner>}

      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingSm">
              Link text
            </Text>
            <InlineStack gap="200">
              <Button size="slim" onClick={handleReset} disabled={isSaving || isDefault}>
                Reset to default
              </Button>
              <Button
                size="slim"
                variant="primary"
                onClick={handleSave}
                loading={isSaving}
                disabled={!isDirty || isSaving}
              >
                Save
              </Button>
            </InlineStack>
          </InlineStack>

          <InlineStack gap="500" align="start" wrap>
            <Box minWidth="320px">
              <BlockStack gap="300">
                <TextField
                  label="Heading text (optional)"
                  value={headingText}
                  onChange={setHeadingText}
                  placeholder="e.g. Your gift certificate"
                  autoComplete="off"
                />
                <TextField
                  label="Link text"
                  value={linkText}
                  onChange={setLinkText}
                  autoComplete="off"
                />
              </BlockStack>
            </Box>

            <Box minWidth="280px">
              <BlockStack gap="200">
                <Text as="span" variant="headingSm">
                  Preview
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  This is how the link will appear in the email.
                </Text>
                <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="100" inlineAlign="center">
                    {headingText && (
                      <Text as="p" fontWeight="bold" alignment="center">
                        {headingText}
                      </Text>
                    )}
                    <span style={{ color: "#2c6ecb", textDecoration: "underline" }}>
                      {linkText || DEFAULT_EMAIL_LINK_TEXT_CLIENT}
                    </span>
                  </BlockStack>
                </Box>
              </BlockStack>
            </Box>
          </InlineStack>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingSm">
              Snippet to paste into your notification template
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
  );
}

type ContactLinkVisibility = "processing" | "delayed" | "both";

type StatusMessages = {
  processingHeading: string;
  processingBody: string;
  delayedHeading: string;
  delayedBody: string;
  contactLink: string;
  contactLinkVisibility: ContactLinkVisibility;
};

const SAMPLE_FIRST_NAME = "Jordan";

// What a customer sees if they click the certificate link before it's ready.
// Both messages stay calm/non-alarming on purpose — "processing" covers the
// first 24 hours (the normal case), "delayed" only shows after that, so a
// routine few-minute wait never reads as something being broken.
function WaitingPageTab({
  initialMessages,
  defaultMessages,
}: {
  initialMessages: StatusMessages;
  defaultMessages: StatusMessages;
}) {
  const fetcher = useFetcher<typeof action>();
  const [messages, setMessages] = useState(initialMessages);
  const [savedMessages, setSavedMessages] = useState(initialMessages);
  const isSaving = fetcher.state !== "idle";
  const isDirty = JSON.stringify(messages) !== JSON.stringify(savedMessages);
  const pendingRef = useRef<StatusMessages | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok || !fetcher.data.statusMessages) return;
    if (pendingRef.current) {
      setSavedMessages(pendingRef.current);
      pendingRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const update = (field: keyof StatusMessages) => (value: string) =>
    setMessages((m) => ({ ...m, [field]: value }));

  const handleSave = () => {
    pendingRef.current = messages;
    fetcher.submit({ intent: "save-status-messages", ...messages }, { method: "post" });
  };

  const handleReset = () => {
    setMessages(defaultMessages);
    pendingRef.current = defaultMessages;
    fetcher.submit({ intent: "save-status-messages", ...defaultMessages }, { method: "post" });
  };

  const error =
    fetcher.data && !fetcher.data.ok && fetcher.data.statusMessages ? fetcher.data.error : null;
  const isDefault = JSON.stringify(messages) === JSON.stringify(defaultMessages);

  return (
    <BlockStack gap="400">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="p" variant="bodySm" tone="subdued">
          What a customer sees if they open the certificate link before it's ready.
        </Text>
        <InlineStack gap="200">
          <Button size="slim" onClick={handleReset} disabled={isSaving || isDefault}>
            Reset to default
          </Button>
          <Button size="slim" variant="primary" onClick={handleSave} loading={isSaving} disabled={!isDirty || isSaving}>
            Save
          </Button>
        </InlineStack>
      </InlineStack>

      {error && <Banner tone="critical">{error}</Banner>}

      <InlineStack gap="400" align="start" wrap>
        <Box minWidth="320px" width="48%">
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="050">
                <Text as="h3" variant="headingSm">
                  While processing (first 24 hours)
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Shown for the first 24 hours after checkout, any time the certificate isn't
                  ready yet when the link is opened.
                </Text>
              </BlockStack>
              <TextField
                label="Heading"
                value={messages.processingHeading}
                onChange={update("processingHeading")}
                autoComplete="off"
              />
              <TextField
                label="Body"
                value={messages.processingBody}
                onChange={update("processingBody")}
                autoComplete="off"
                multiline={3}
              />
            </BlockStack>
          </Card>
        </Box>

        <Box minWidth="320px" width="48%">
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="050">
                <Text as="h3" variant="headingSm">
                  If still not ready after 24 hours
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Replaces the message above once more than 24 hours have passed since checkout
                  and the certificate still isn't ready.
                </Text>
              </BlockStack>
              <TextField
                label="Heading"
                value={messages.delayedHeading}
                onChange={update("delayedHeading")}
                autoComplete="off"
              />
              <TextField
                label="Body"
                value={messages.delayedBody}
                onChange={update("delayedBody")}
                autoComplete="off"
                multiline={3}
              />
            </BlockStack>
          </Card>
        </Box>
      </InlineStack>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Contact link (optional)
          </Text>
          <TextField
            label="Email or URL"
            labelHidden
            value={messages.contactLink}
            onChange={update("contactLink")}
            autoComplete="off"
            placeholder="support@yourstore.com or https://yourstore.com/pages/contact"
          />
          <BlockStack gap="100">
            <Text as="span" variant="bodySm" fontWeight="medium">
              Show it on
            </Text>
            <ButtonGroup variant="segmented">
              <Button
                size="slim"
                pressed={messages.contactLinkVisibility === "processing"}
                onClick={() => setMessages((m) => ({ ...m, contactLinkVisibility: "processing" }))}
              >
                Processing only
              </Button>
              <Button
                size="slim"
                pressed={messages.contactLinkVisibility === "delayed"}
                onClick={() => setMessages((m) => ({ ...m, contactLinkVisibility: "delayed" }))}
              >
                Delayed only
              </Button>
              <Button
                size="slim"
                pressed={messages.contactLinkVisibility === "both"}
                onClick={() => setMessages((m) => ({ ...m, contactLinkVisibility: "both" }))}
              >
                Both
              </Button>
            </ButtonGroup>
          </BlockStack>
        </BlockStack>
      </Card>

      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">
          Preview
        </Text>
        <InlineStack gap="400" align="start" wrap>
          <Box minWidth="320px" width="48%">
            <StatusMessagePreview
              firstName={SAMPLE_FIRST_NAME}
              heading={messages.processingHeading}
              body={messages.processingBody}
              contactLink={
                messages.contactLinkVisibility === "processing" ||
                messages.contactLinkVisibility === "both"
                  ? messages.contactLink
                  : ""
              }
              delayed={false}
            />
          </Box>
          <Box minWidth="320px" width="48%">
            <StatusMessagePreview
              firstName={SAMPLE_FIRST_NAME}
              heading={messages.delayedHeading}
              body={messages.delayedBody}
              contactLink={
                messages.contactLinkVisibility === "delayed" ||
                messages.contactLinkVisibility === "both"
                  ? messages.contactLink
                  : ""
              }
              delayed
            />
          </Box>
        </InlineStack>
      </BlockStack>
    </BlockStack>
  );
}

// Mirrors certificate-status.server.ts's resolveContactHref for preview
// purposes only — trivial enough to duplicate rather than pull a .server
// module into client-rendered code.
function resolveContactHrefPreview(contactLink: string): string | null {
  const trimmed = contactLink.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return `mailto:${trimmed}`;
  return `https://${trimmed}`;
}

function StatusMessagePreview({
  firstName,
  heading,
  body,
  contactLink,
  delayed,
}: {
  firstName: string;
  heading: string;
  body: string;
  contactLink?: string;
  delayed: boolean;
}) {
  const contactHref = contactLink ? resolveContactHrefPreview(contactLink) : null;

  return (
    <Box padding="500" background="bg-surface-secondary" borderRadius="200">
      <div
        style={{
          maxWidth: "380px",
          margin: "0 auto",
          background: "#ffffff",
          borderRadius: "12px",
          padding: "32px 28px",
          textAlign: "center",
          boxShadow: "0 1px 6px rgba(0, 0, 0, 0.08)",
          fontFamily: "Arial, Helvetica, sans-serif",
        }}
      >
        <p style={{ fontSize: "13px", color: "#6b7889", margin: "0 0 4px" }}>Hi {firstName},</p>
        <h3 style={{ fontSize: "18px", margin: "0 0 10px", color: "#16283f" }}>{heading}</h3>
        <p style={{ fontSize: "14px", lineHeight: 1.6, color: "#4a5b70", margin: 0 }}>{body}</p>
        {contactHref && delayed && (
          <a
            href={contactHref}
            style={{
              display: "inline-block",
              marginTop: "20px",
              padding: "9px 18px",
              background: "#16283f",
              color: "#ffffff",
              borderRadius: "8px",
              fontSize: "13px",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Contact us
          </a>
        )}
        {contactHref && !delayed && (
          <p style={{ fontSize: "12px", color: "#8592a1", margin: "16px 0 0" }}>
            Still don't see it?{" "}
            <a href={contactHref} style={{ color: "#2c6ecb", textDecoration: "underline" }}>
              You can contact us
            </a>
            .
          </p>
        )}
      </div>
    </Box>
  );
}

function VariablesTab({ variables }: { variables: { key: string; description: string }[] }) {
  const shopify = useAppBridge();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = async (key: string) => {
    const token = `{{${key}}}`;
    try {
      await navigator.clipboard.writeText(token);
      setCopiedKey(key);
      shopify.toast.show(`Copied ${token}`);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      shopify.toast.show("Couldn't copy to clipboard", { isError: true });
    }
  };

  return (
    <BlockStack gap="300">
      <Text as="p" variant="bodySm" tone="subdued">
        Click a variable to copy it, then paste it into the template code.
      </Text>
      <BlockStack gap="200">
        {variables.map((v) => (
          <Box key={v.key} padding="300" background="bg-surface-secondary" borderRadius="200">
            <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
              <Text as="span" variant="bodySm" tone="subdued">
                {v.description}
              </Text>
              <button
                type="button"
                onClick={() => handleCopy(v.key)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "6px 10px",
                  background: "#ffffff",
                  border: "1px solid #c9cccf",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: "13px",
                  color: "#1a1a1a",
                  flexShrink: 0,
                }}
              >
                {`{{${v.key}}}`}
                <Icon source={copiedKey === v.key ? CheckIcon : ClipboardIcon} tone={copiedKey === v.key ? "success" : "base"} />
              </button>
            </InlineStack>
          </Box>
        ))}
      </BlockStack>
    </BlockStack>
  );
}

function AssetUploadRow({
  assetKey,
  label,
  url,
  isCustom,
}: {
  assetKey: CertificateAssetKey;
  label: string;
  url: string;
  isCustom: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const isBusy = fetcher.state !== "idle";
  const error =
    fetcher.data && !fetcher.data.ok && fetcher.data.assetKey === assetKey
      ? fetcher.data.error
      : null;

  const handleDrop = useCallback(
    (_dropFiles: File[], acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;
      const formData = new FormData();
      formData.append("intent", "upload-asset");
      formData.append("key", assetKey);
      formData.append("file", file);
      fetcher.submit(formData, { method: "post", encType: "multipart/form-data" });
    },
    [assetKey, fetcher],
  );

  const handleReset = () => {
    fetcher.submit({ intent: "reset-asset", key: assetKey }, { method: "post" });
  };

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h3" variant="bodyMd" fontWeight="medium">
              {label}
            </Text>
            <Badge tone={isCustom ? "attention" : undefined}>
              {isCustom ? "Customized" : "Default"}
            </Badge>
          </InlineStack>
          {isCustom && (
            <Button size="slim" onClick={handleReset} disabled={isBusy}>
              Reset to default
            </Button>
          )}
        </InlineStack>

        <DropZone onDrop={handleDrop} allowMultiple={false} accept="image/*" disabled={isBusy}>
          <Box padding="300">
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <Thumbnail source={url} alt={label} size="large" />
              <BlockStack gap="050">
                <Text as="span" variant="bodySm" fontWeight="medium">
                  {isBusy ? "Uploading…" : "Drop an image or click to replace"}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  PNG, JPG, or SVG
                </Text>
              </BlockStack>
            </InlineStack>
          </Box>
        </DropZone>

        {error && <Banner tone="critical">{error}</Banner>}
      </BlockStack>
    </Card>
  );
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

function CertificatePagePreview({ html }: { html: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(1);
  const [zoomOverride, setZoomOverride] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const widthScale = el.clientWidth / PAGE_WIDTH;
      const heightScale = el.clientHeight / PAGE_HEIGHT;
      setFitScale(Math.min(widthScale, heightScale));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scale = zoomOverride ?? fitScale;
  const isFit = zoomOverride === null;

  const zoomBy = (delta: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((scale + delta).toFixed(2))));
    setZoomOverride(next);
  };

  return (
    <Box>
      <Box padding="200" background="bg-surface-secondary">
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <Text as="span" variant="bodySm" tone="subdued">
            Sample data — not a real order. Shown at the same Letter page size the PDF is
            generated at.
          </Text>
          <InlineStack gap="150" blockAlign="center">
            <Button
              size="slim"
              onClick={() => zoomBy(-ZOOM_STEP)}
              disabled={scale <= MIN_ZOOM}
              accessibilityLabel="Zoom out"
            >
              −
            </Button>
            <Box minWidth="42px">
              <Text as="span" variant="bodySm" alignment="center">
                {Math.round(scale * 100)}%
              </Text>
            </Box>
            <Button
              size="slim"
              onClick={() => zoomBy(ZOOM_STEP)}
              disabled={scale >= MAX_ZOOM}
              accessibilityLabel="Zoom in"
            >
              +
            </Button>
            <Button size="slim" onClick={() => setZoomOverride(null)} disabled={isFit}>
              Fit
            </Button>
          </InlineStack>
        </InlineStack>
      </Box>
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: PANEL_HEIGHT,
          overflow: "auto",
          background: "#e3e3e3",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "24px 16px",
          }}
        >
          <div
            style={{
              width: PAGE_WIDTH * scale,
              height: PAGE_HEIGHT * scale,
              flexShrink: 0,
              boxShadow: "0 1px 6px rgba(0, 0, 0, 0.25)",
            }}
          >
            <div
              style={{
                width: PAGE_WIDTH,
                height: PAGE_HEIGHT,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
            >
              <iframe
                title="Certificate preview"
                srcDoc={html}
                style={{
                  width: PAGE_WIDTH,
                  height: PAGE_HEIGHT,
                  border: "none",
                  display: "block",
                  background: "#ffffff",
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </Box>
  );
}
