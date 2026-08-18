import db from "./db.server";

// Markup the widget script injects into #ctaw-root. Class names and ids
// (ctaw-form, ctaw-input, ctaw-btn, ctaw-btn-text, ctaw-spinner, ctaw-result)
// are what the JS attaches behavior to — editing text/attributes is safe,
// removing those hooks breaks the widget.
export const DEFAULT_WIDGET_HTML = `<div class="ctaw-card">
  <form class="ctaw-form">
    <label class="ctaw-label" for="ctaw-input">Enter your gift code</label>
    <div class="ctaw-row">
      <input class="ctaw-input" id="ctaw-input" type="text" placeholder="e.g. TT-ABCD-1234" autocomplete="off" required>
      <button class="ctaw-btn" type="submit">
        <span class="ctaw-btn-text">Check code</span>
        <span class="ctaw-spinner" hidden></span>
      </button>
    </div>
  </form>
  <div class="ctaw-result" role="status" aria-live="polite" hidden></div>
</div>`;

export const DEFAULT_WIDGET_CSS = `#ctaw-root {
  max-width: 460px;
  margin: 0 auto;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
#ctaw-root .ctaw-card {
  background: #fff;
  border: 1px solid #e3e3e3;
  border-radius: 12px;
  padding: 28px 24px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}
#ctaw-root .ctaw-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: #1a1a1a;
  margin-bottom: 10px;
}
#ctaw-root .ctaw-row {
  display: flex;
  gap: 10px;
}
#ctaw-root .ctaw-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid #d1d3d6;
  border-radius: 8px;
  font-size: 15px;
  color: #1a1a1a;
  transition: border-color 0.15s ease;
}
#ctaw-root .ctaw-input:focus {
  outline: none;
  border-color: #1a1a1a;
}
#ctaw-root .ctaw-btn {
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
#ctaw-root .ctaw-btn:hover {
  opacity: 0.88;
}
#ctaw-root .ctaw-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
#ctaw-root .ctaw-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: ctaw-spin 0.7s linear infinite;
}
@keyframes ctaw-spin {
  to {
    transform: rotate(360deg);
  }
}
#ctaw-root .ctaw-result {
  margin-top: 16px;
  padding: 14px 16px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.5;
}
#ctaw-root .ctaw-result[data-state="success"] {
  background: #ecf7ee;
  color: #1a5c2a;
  border: 1px solid #cdeed3;
}
#ctaw-root .ctaw-result[data-state="redeemed"] {
  background: #fdf3e3;
  color: #8a5b00;
  border: 1px solid #f6e2b8;
}
#ctaw-root .ctaw-result[data-state="error"] {
  background: #fbeceb;
  color: #a3231c;
  border: 1px solid #f5cfcc;
}
@media (max-width: 420px) {
  #ctaw-root .ctaw-row {
    flex-direction: column;
  }
  #ctaw-root .ctaw-btn {
    padding: 12px;
  }
}`;

export async function getVerifyWidgetSettings(
  shop: string,
): Promise<{ html: string; css: string; isHtmlCustom: boolean; isCssCustom: boolean }> {
  const record = await db.verifyWidgetSettings.findUnique({ where: { shop } });
  return {
    html: record?.html ?? DEFAULT_WIDGET_HTML,
    css: record?.css ?? DEFAULT_WIDGET_CSS,
    isHtmlCustom: Boolean(record?.html),
    isCssCustom: Boolean(record?.css),
  };
}

export async function saveVerifyWidgetHtml(shop: string, html: string): Promise<void> {
  await db.verifyWidgetSettings.upsert({
    where: { shop },
    create: { shop, html },
    update: { html },
  });
}

export async function saveVerifyWidgetCss(shop: string, css: string): Promise<void> {
  await db.verifyWidgetSettings.upsert({
    where: { shop },
    create: { shop, css },
    update: { css },
  });
}

export async function resetVerifyWidgetHtml(shop: string): Promise<void> {
  await db.verifyWidgetSettings.updateMany({ where: { shop }, data: { html: null } });
}

export async function resetVerifyWidgetCss(shop: string): Promise<void> {
  await db.verifyWidgetSettings.updateMany({ where: { shop }, data: { css: null } });
}

// Builds the widget's behavior script with the (possibly customized) markup
// embedded as a string literal. The script derives its own API origin from
// its own <script src>, so it needs no other per-shop templating.
export function buildWidgetScript(html: string): string {
  return `(function () {
  var scriptEl = document.currentScript;
  var apiOrigin = scriptEl ? new URL(scriptEl.src).origin : "";
  var API_URL = apiOrigin + "/api/verify-code";
  var CACHE_TTL_MS = 5 * 60 * 1000;

  var root = document.getElementById("ctaw-root");
  if (!root) return;

  root.innerHTML = ${JSON.stringify(html)};

  var form = root.querySelector(".ctaw-form");
  var input = root.querySelector(".ctaw-input");
  var button = root.querySelector(".ctaw-btn");
  var btnText = button.querySelector(".ctaw-btn-text");
  var spinner = button.querySelector(".ctaw-spinner");
  var resultEl = root.querySelector(".ctaw-result");

  function cacheKey(code) {
    return "ctaw_verify_" + code;
  }

  function readCache(code) {
    try {
      var raw = sessionStorage.getItem(cacheKey(code));
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
      return entry.data;
    } catch (err) {
      return null;
    }
  }

  function writeCache(code, data) {
    try {
      sessionStorage.setItem(cacheKey(code), JSON.stringify({ timestamp: Date.now(), data: data }));
    } catch (err) {}
  }

  function formatDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } catch (err) {
      return "";
    }
  }

  function renderResult(data) {
    resultEl.hidden = false;

    if (!data.found) {
      resultEl.dataset.state = "error";
      resultEl.textContent = data.message || "We couldn't find that code.";
      return;
    }
    if (data.status === "redeemed") {
      resultEl.dataset.state = "redeemed";
      resultEl.textContent =
        "This code has already been redeemed" + (data.redeemedAt ? " on " + formatDate(data.redeemedAt) + "." : ".");
      return;
    }
    if (data.status === "revoked") {
      resultEl.dataset.state = "error";
      resultEl.textContent = "This code is no longer valid.";
      return;
    }
    resultEl.dataset.state = "success";
    resultEl.textContent = "This code is valid and ready to redeem.";
  }

  function setLoading(loading) {
    button.disabled = loading;
    btnText.textContent = loading ? "Checking" : "Check code";
    spinner.hidden = !loading;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var code = input.value.trim().toUpperCase();
    if (!code) return;

    var cached = readCache(code);
    if (cached) {
      renderResult(cached);
      return;
    }

    setLoading(true);
    resultEl.hidden = true;

    fetch(API_URL + "?code=" + encodeURIComponent(code))
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        writeCache(code, data);
        renderResult(data);
      })
      .catch(function () {
        resultEl.hidden = false;
        resultEl.dataset.state = "error";
        resultEl.textContent = "Something went wrong checking that code. Please try again in a moment.";
      })
      .finally(function () {
        setLoading(false);
      });
  });
})();
`;
}
