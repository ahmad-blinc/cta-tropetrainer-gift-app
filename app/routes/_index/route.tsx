import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>TropeTrainer Gift Subscription</h1>
        <p className={styles.text}>
          Issues TropeTrainer activation codes and gift certificates for Chant Torah America's
          One-Year Subscription Gift product.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Automatic code issuance</strong>. Calls the TropeTrainer API when a gift
            subscription order is placed and tracks the result.
          </li>
          <li>
            <strong>Branded certificates</strong>. Generates a PDF gift certificate, linked
            directly from the order confirmation email.
          </li>
          <li>
            <strong>Admin visibility</strong>. See issued, pending, and failed codes, and
            configure certificate branding, from one settings page.
          </li>
        </ul>
      </div>
    </div>
  );
}
