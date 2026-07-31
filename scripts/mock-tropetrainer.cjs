const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 4001;

function randomCode() {
  const part = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `${part()}-${part()}-${part()}`;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    console.log(`[mock] ${req.method} ${req.url}`);
    console.log(`[mock] Idempotency-Key: ${req.headers["idempotency-key"]}`);
    console.log(`[mock] Authorization present: ${!!req.headers["authorization"]}`);

    if (req.method !== "POST" || req.url !== "/api/access-codes") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (!req.headers["authorization"]) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (process.env.MOCK_FORCE_ERROR) {
      const errorBody = {
        error: {
          type: "payment_error",
          code: "payment_declined",
          message: "The configured payment method was declined.",
          retryable: false,
          request_id: `req_${crypto.randomBytes(6).toString("hex")}`,
          payment: { decline_code: "insufficient_funds" },
        },
      };
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify(errorBody));
      return;
    }

    const response = {
      id: `ac_${crypto.randomBytes(8).toString("hex")}`,
      key: req.headers["idempotency-key"] || "unknown",
      status: "issued",
      code: randomCode(),
      license: { duration_days: 360, starts_at: "redemption" },
      purchase: { amount_paid: 15600, currency: "usd" },
      created_at: new Date().toISOString(),
    };

    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Request-Id": `req_${crypto.randomBytes(6).toString("hex")}`,
    });
    res.end(JSON.stringify(response));
  });
});

server.listen(PORT, () => {
  console.log(`[mock] TropeTrainer mock server listening on http://localhost:${PORT}`);
});
