import type { LoaderFunctionArgs } from "@remix-run/node";
import { getVerifyWidgetSettings, DEFAULT_WIDGET_CSS } from "../verify-widget.server";

// Publicly served — loaded via a <link> tag from the storefront (a
// different origin than this app), so no auth. Cross-origin stylesheets
// don't require CORS headers to be applied by the browser.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = new URL(request.url).searchParams.get("shop");
  const css = shop ? (await getVerifyWidgetSettings(shop)).css : DEFAULT_WIDGET_CSS;

  return new Response(css, {
    headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" },
  });
};
