# TropeTrainer Gift Subscription

Shopify custom app for **Chant Torah America** (store: `chant-torah-america.myshopify.com`). When a customer buys the "One Year Subscription Gift" product, the app calls the TropeTrainer API to issue an activation code, then serves a branded PDF certificate at a public link included in the order confirmation email.

**Contents:** [What it does](#what-it-does) · [Stack](#stack) · [Environment variables](#required-environment-variables) · [Local dev](#local-development) · [Deploying](#deploying-railway) · [Switching to the real key](#switching-to-the-real-tropetrainer-key-go-live) · [Testing without the real key](#testing-without-the-real-tropetrainer-key) · [Repo layout](#repo-layout)

## What it does

1. Customer buys the gift subscription product on the storefront (custom line-item properties capture student info, purchaser/clergy info, and an attestation checkbox — see the theme's `snippets/buy-buttons.liquid`, not part of this repo).
2. `orders/paid` webhook (`app/routes/webhooks.orders.paid.tsx`) fires, checks whether any line item's product has the `subscription_gift` tag, and if so calls the TropeTrainer API (`app/tropetrainer.server.ts`) to issue a code, recording the result in the `GiftCode` table.
3. The order confirmation email (Shopify notification template, edited directly in Shopify admin) includes a certificate link built from `order.id` + a static per-shop signing key — computable entirely in Liquid, so it doesn't depend on the webhook having finished by the time the email sends.
4. That link (`app/routes/certificate.$orderId.tsx`) renders the certificate as a PDF via Puppeteer, or a friendly "still processing" page if the code isn't issued yet.
5. Admin UI (`app/routes/app._index.tsx`, `app.settings.tsx`, `app.certificate.tsx`) lets the merchant see issued/failed/pending codes, configure the certificate template and brand assets, and check TropeTrainer connection status.

## Stack

- Remix 2 (Vite), `@shopify/shopify-app-remix`, Polaris
- Prisma + **PostgreSQL** in production (see gotcha below — do not switch this back to SQLite)
- Puppeteer for PDF rendering
- Hosted on **Railway** (see `Dockerfile`)

## Required environment variables

| Variable | Notes |
|---|---|
| `SHOPIFY_API_KEY` | From `shopify.app.cta-tropetrainer-gift-app.toml` / Partner Dashboard |
| `SHOPIFY_API_SECRET` | Partner Dashboard → app credentials |
| `SCOPES` | `read_orders,write_orders,read_products,write_files` |
| `SHOPIFY_APP_URL` | The app's public URL (Railway domain) |
| `DATABASE_URL` | Postgres connection string. On Railway, reference the Postgres service: `${{Postgres.DATABASE_URL}}` |
| `CERTIFICATE_SECRET` | Random secret for signing certificate tokens/links. Falls back to `SHOPIFY_API_SECRET` if unset — set it explicitly in production. |
| `TROPETRAINER_API_KEY` | Real key from TropeTrainer. **Without this, the app safely no-ops** (shows "Not configured" in Settings, doesn't crash) — see below. |
| `TROPETRAINER_API_URL` | Only set this to override the default production TropeTrainer endpoint (e.g. for testing, or against a mock). Currently set to TropeTrainer's **test** endpoint (`.../api/test/access-codes`) — production is intentionally on hold until the client coordinates activation with TropeTrainer. See "Switching to the real key" below for how to flip it. |

The admin Settings page (`app.settings.tsx`) shows live status for the last two — a warning banner appears if the API key is missing or the endpoint isn't the default production one. Check that page after any deploy that touches these.

## Local development

```shell
npm install
npm run dev   # shopify app dev — handles tunneling, OAuth, config
```

Local dev uses SQLite (`prisma/schema.prisma` datasource is Postgres for production — see the deploy step below for why local dev can differ).

## Deploying (Railway)

The app is hosted on Railway, not Vercel/Heroku — the Shopify Remix template needs a persistent server (webhook auth, session handling), which doesn't fit Vercel's serverless model.

1. Push to `main` — Railway is connected via the GitHub App and auto-deploys.
2. Config changes in `shopify.app.cta-tropetrainer-gift-app.toml` (scopes, webhooks, app URL, name) need a **separate** manual step — `npm run deploy` (runs `shopify app deploy`) — pushing to GitHub does **not** update the Partner Dashboard.
3. `npm run setup` (runs on every container boot via `docker-start`) does `prisma generate && prisma migrate deploy`, applying any new files in `prisma/migrations/`. To change the schema going forward: edit `prisma/schema.prisma`, then run `prisma migrate dev --name <description>` against a real Postgres connection (e.g. Railway's `DATABASE_PUBLIC_URL`) to generate the migration file, and commit it — don't hand-edit migration SQL or use `db push` against production.

### Switching to the real TropeTrainer key (go-live)

The key/URL live only as Railway env vars on the main app service — never in the database or the app's UI, since they're a credential, not merchant-facing configuration.

1. Railway dashboard → **cta-tropetrainer-gift-app** service → **Variables**.
2. Set `TROPETRAINER_API_KEY` to the production key from the client.
3. Either delete `TROPETRAINER_API_URL` entirely (the code's default is already the production endpoint) or set it explicitly to `https://www.tropetrainer.com/api/access-codes`.
4. Railway auto-redeploys on variable change — wait for the deploy to show Success.
5. Verify in the app: Shopify admin → **Settings** page → "TropeTrainer connection" card should show API key **Configured** and endpoint **Production**. If it doesn't update within a minute, manually trigger **Deployments → ⋮ → Redeploy** on the latest deployment.

<details>
<summary><strong>Known infrastructure gotchas</strong> (already fixed — click to expand for why)</summary>

- **Dockerfile must use `node:20-alpine`, not `node:18`.** `@shopify/shopify-app-remix`'s webhook HMAC validation needs the global Web Crypto API, unavailable on Node 18. `package.json`'s `engines` field reflects the real requirement.
- **Puppeteer needs Alpine's own `chromium` package.** Puppeteer's bundled Chromium download is built for glibc and doesn't run on Alpine (musl). The Dockerfile installs `chromium` via `apk` and points Puppeteer at it via `PUPPETEER_EXECUTABLE_PATH`.
- **`certificate.$orderId.tsx` must never export a default component or an `ErrorBoundary`.** Remix only serves a loader's raw `Response` (needed to return PDF bytes directly) when the route module has neither — otherwise every response, including successful ones, gets wrapped in the full HTML document shell. Non-PDF states (invalid link, still processing, error) are returned as hand-built HTML `Response`s from the loader instead of thrown errors.
- **`package-lock.json` must be committed** (it's intentionally *not* gitignored, despite what a default Node `.gitignore` might suggest) — `npm ci` in the Dockerfile fails without it.

</details>

## Testing without the real TropeTrainer key

`scripts/mock-tropetrainer.cjs` is a minimal fake TropeTrainer server (responds instantly with a fake issued code). Useful for testing the full order → webhook → code → certificate → email pipeline without needing the real API key. To use it:

1. Deploy it as its own Railway service from this same repo, with its start command overridden to `node scripts/mock-tropetrainer.cjs`.
2. Generate a domain for it, matching the port it actually listens on (it respects `PORT`).
3. Temporarily set `TROPETRAINER_API_URL` on the main app to that domain + `/api/access-codes`, and any non-empty `TROPETRAINER_API_KEY`.
4. **Remove both variables (or delete the mock service) once done** — leaving the app pointed at the mock in production means real customers get fake codes.

## Repo layout

```
app/
  routes/
    app.*.tsx              — embedded admin UI (Home, Settings, Certificate editor, order details)
    webhooks.*.tsx          — orders/paid, app/uninstalled, app/scopes_update
    certificate.$orderId.tsx — public certificate PDF route (see gotcha above)
  certificate.server.ts     — certificate template, PDF generation, signed link helpers
  certificate-assets.server.ts — brand asset (seal/logo) uploads via Shopify Files API
  certificate-status.server.ts — configurable waiting-page copy
  gift-order.server.ts      — gift product detection, code issuance orchestration
  tropetrainer.server.ts    — TropeTrainer API client
prisma/
  schema.prisma             — Postgres datasource; GiftCode, CertificateAsset, etc.
scripts/
  mock-tropetrainer.cjs     — fake TropeTrainer server for testing (see above)
```
