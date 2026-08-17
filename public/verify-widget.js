(function () {
  var scriptEl = document.currentScript;
  var apiOrigin = scriptEl ? new URL(scriptEl.src).origin : "";
  var API_URL = apiOrigin + "/api/verify-code";
  var CACHE_TTL_MS = 5 * 60 * 1000;

  var root = document.getElementById("ctaw-root");
  if (!root) return;

  root.innerHTML =
    '<div class="ctaw-card">' +
      '<form class="ctaw-form">' +
        '<label class="ctaw-label" for="ctaw-input">Enter your gift code</label>' +
        '<div class="ctaw-row">' +
          '<input class="ctaw-input" id="ctaw-input" type="text" placeholder="e.g. TT-ABCD-1234" autocomplete="off" required>' +
          '<button class="ctaw-btn" type="submit">' +
            '<span class="ctaw-btn-text">Check code</span>' +
            '<span class="ctaw-spinner" hidden></span>' +
          "</button>" +
        "</div>" +
      "</form>" +
      '<div class="ctaw-result" role="status" aria-live="polite" hidden></div>' +
    "</div>";

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
