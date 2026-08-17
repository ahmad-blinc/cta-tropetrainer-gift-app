import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useMemo, useState } from "react";
import { Page, Card, BlockStack, InlineStack, Text, Box, Icon } from "@shopify/polaris";
import { ClipboardIcon, CheckIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getInstantCertificateLinkParts } from "../certificate.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { appUrl } = getInstantCertificateLinkParts(session.shop);
  return json({ appUrl });
};

// Self-contained widget (HTML + CSS + JS) meant to be pasted into a Custom
// Liquid section on a storefront page — renders a code-entry box that calls
// this app's public /api/verify-code endpoint. sessionStorage caches a
// result for 5 minutes per browser so a user re-checking the same code
// doesn't re-hit the live TropeTrainer lookup on every submit.
function buildVerifyWidgetSnippet(appUrl: string): string {
  return `<div class="ctaw" id="ctaw-root">
  <div class="ctaw-card">
    <form class="ctaw-form" id="ctaw-form">
      <label class="ctaw-label" for="ctaw-input">Enter your gift code</label>
      <div class="ctaw-row">
        <input class="ctaw-input" id="ctaw-input" type="text" placeholder="e.g. TT-ABCD-1234" autocomplete="off" required>
        <button class="ctaw-btn" id="ctaw-btn" type="submit">
          <span class="ctaw-btn-text">Check code</span>
          <span class="ctaw-spinner" hidden></span>
        </button>
      </div>
    </form>
    <div class="ctaw-result" id="ctaw-result" role="status" aria-live="polite" hidden></div>
  </div>
</div>

<style>
  .ctaw { max-width: 460px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .ctaw-card { background: #fff; border: 1px solid #e3e3e3; border-radius: 12px; padding: 28px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .ctaw-label { display: block; font-size: 14px; font-weight: 600; color: #1a1a1a; margin-bottom: 10px; }
  .ctaw-row { display: flex; gap: 10px; }
  .ctaw-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 12px 14px;
    border: 1px solid #d1d3d6;
    border-radius: 8px;
    font-size: 15px;
    color: #1a1a1a;
    transition: border-color 0.15s ease;
  }
  .ctaw-input:focus { outline: none; border-color: #1a1a1a; }
  .ctaw-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 20px;
    border: none;
    border-radius: 8px;
    background: #1a1a1a;
    color: #fff;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.15s ease;
  }
  .ctaw-btn:hover { opacity: 0.88; }
  .ctaw-btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .ctaw-spinner {
    width: 14px; height: 14px;
    border: 2px solid rgba(255,255,255,0.35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: ctaw-spin 0.7s linear infinite;
  }
  @keyframes ctaw-spin { to { transform: rotate(360deg); } }
  .ctaw-result {
    margin-top: 16px;
    padding: 14px 16px;
    border-radius: 8px;
    font-size: 14px;
    line-height: 1.5;
  }
  .ctaw-result[data-state="success"] { background: #ecf7ee; color: #1a5c2a; border: 1px solid #cdeed3; }
  .ctaw-result[data-state="redeemed"] { background: #fdf3e3; color: #8a5b00; border: 1px solid #f6e2b8; }
  .ctaw-result[data-state="error"] { background: #fbeceb; color: #a3231c; border: 1px solid #f5cfcc; }
  @media (max-width: 420px) {
    .ctaw-row { flex-direction: column; }
    .ctaw-btn { padding: 12px; }
  }
</style>

<script>
(function () {
  var API_URL = '${appUrl}/api/verify-code';
  var CACHE_TTL_MS = 5 * 60 * 1000;

  var form = document.getElementById('ctaw-form');
  var input = document.getElementById('ctaw-input');
  var button = document.getElementById('ctaw-btn');
  var btnText = button ? button.querySelector('.ctaw-btn-text') : null;
  var spinner = button ? button.querySelector('.ctaw-spinner') : null;
  var resultEl = document.getElementById('ctaw-result');
  if (!form || !input || !button || !resultEl) return;

  function cacheKey(code) { return 'ctaw_verify_' + code; }

  function readCache(code) {
    try {
      var raw = sessionStorage.getItem(cacheKey(code));
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
      return entry.data;
    } catch (err) { return null; }
  }

  function writeCache(code, data) {
    try {
      sessionStorage.setItem(cacheKey(code), JSON.stringify({ timestamp: Date.now(), data: data }));
    } catch (err) {}
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (err) { return ''; }
  }

  function renderResult(data) {
    resultEl.hidden = false;

    if (!data.found) {
      resultEl.dataset.state = 'error';
      resultEl.textContent = data.message || "We couldn't find that code.";
      return;
    }
    if (data.status === 'redeemed') {
      resultEl.dataset.state = 'redeemed';
      resultEl.textContent = 'This code has already been redeemed' +
        (data.redeemedAt ? ' on ' + formatDate(data.redeemedAt) + '.' : '.');
      return;
    }
    if (data.status === 'revoked') {
      resultEl.dataset.state = 'error';
      resultEl.textContent = 'This code is no longer valid.';
      return;
    }
    resultEl.dataset.state = 'success';
    resultEl.textContent = 'This code is valid and ready to redeem.';
  }

  function setLoading(loading) {
    button.disabled = loading;
    if (btnText) btnText.textContent = loading ? 'Checking' : 'Check code';
    if (spinner) spinner.hidden = !loading;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var code = input.value.trim().toUpperCase();
    if (!code) return;

    var cached = readCache(code);
    if (cached) { renderResult(cached); return; }

    setLoading(true);
    resultEl.hidden = true;

    fetch(API_URL + '?code=' + encodeURIComponent(code))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        writeCache(code, data);
        renderResult(data);
      })
      .catch(function () {
        resultEl.hidden = false;
        resultEl.dataset.state = 'error';
        resultEl.textContent = 'Something went wrong checking that code. Please try again in a moment.';
      })
      .finally(function () { setLoading(false); });
  });
})();
</script>`;
}

export default function VerifyCode() {
  const { appUrl } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const [copied, setCopied] = useState(false);
  const snippet = useMemo(() => buildVerifyWidgetSnippet(appUrl), [appUrl]);

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
      <TitleBar title="Verify Code" />
      <BlockStack gap="500">
        <Text as="p" variant="bodySm" tone="subdued">
          Lets customers check whether a gift code has been redeemed, right from your store. In
          Shopify admin, go to{" "}
          <Text as="span" variant="bodySm" fontWeight="medium">
            Online Store → Pages
          </Text>{" "}
          and create a page (e.g. "Verify Your Gift Code"), then add a{" "}
          <Text as="span" variant="bodySm" fontWeight="medium">
            Custom Liquid
          </Text>{" "}
          section in the theme editor and paste the snippet below into it.
        </Text>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingSm">
              Live preview
            </Text>
            <Box borderRadius="200" overflowX="hidden" background="bg-surface-secondary">
              <iframe
                title="Verify code widget preview"
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
                Snippet to paste into a Custom Liquid section
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
              <div style={{ maxHeight: "320px", overflowY: "auto" }}>
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
              </div>
            </Box>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
