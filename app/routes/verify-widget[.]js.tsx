import type { LoaderFunctionArgs } from "@remix-run/node";
import { getVerifyWidgetSettings, buildWidgetScript, DEFAULT_WIDGET_HTML } from "../verify-widget.server";

// Publicly served — loaded via a <script src> from the storefront (a
// different origin than this app), so no auth.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = new URL(request.url).searchParams.get("shop");
  const html = shop ? (await getVerifyWidgetSettings(shop)).html : DEFAULT_WIDGET_HTML;

  return new Response(buildWidgetScript(html), {
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
  });
};
