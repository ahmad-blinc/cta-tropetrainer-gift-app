import db from "./db.server";
import type { AdminClient } from "./gift-order.server";

export const CERTIFICATE_ASSET_KEYS = ["seal", "tropetrainerLogo", "cantorsLogo"] as const;
export type CertificateAssetKey = (typeof CERTIFICATE_ASSET_KEYS)[number];

export const CERTIFICATE_ASSET_LABELS: Record<CertificateAssetKey, string> = {
  seal: "Chant Torah America seal",
  tropetrainerLogo: "TropeTrainer logo",
  cantorsLogo: "Cantors Assembly partnership badge",
};

const DEFAULT_ASSET_FILENAMES: Record<CertificateAssetKey, string> = {
  seal: "seal-default.png",
  tropetrainerLogo: "tropetrainer-logo-default.png",
  cantorsLogo: "cantors-logo-default.png",
};

export function getDefaultAssetUrl(key: CertificateAssetKey): string {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  return `${base}/certificate-assets/${DEFAULT_ASSET_FILENAMES[key]}`;
}

export type CertificateAssetUrls = Record<CertificateAssetKey, string>;

export async function getCertificateAssetUrls(shop: string): Promise<CertificateAssetUrls> {
  const rows = await db.certificateAsset.findMany({ where: { shop } });
  const overrides = new Map(rows.map((r) => [r.key, r.url]));
  return {
    seal: overrides.get("seal") ?? getDefaultAssetUrl("seal"),
    tropetrainerLogo: overrides.get("tropetrainerLogo") ?? getDefaultAssetUrl("tropetrainerLogo"),
    cantorsLogo: overrides.get("cantorsLogo") ?? getDefaultAssetUrl("cantorsLogo"),
  };
}

export async function getCertificateAssetOverrideKeys(shop: string): Promise<Set<string>> {
  const rows = await db.certificateAsset.findMany({ where: { shop }, select: { key: true } });
  return new Set(rows.map((r) => r.key));
}

export async function resetCertificateAsset(shop: string, key: CertificateAssetKey): Promise<void> {
  await db.certificateAsset.deleteMany({ where: { shop, key } });
}

// Uploads a merchant-supplied image to Shopify's own file storage (no storage
// of our own to manage) and records the resulting CDN url as this shop's
// override for the given certificate asset slot.
export async function uploadCertificateAsset(
  admin: AdminClient,
  shop: string,
  key: CertificateAssetKey,
  file: File,
): Promise<string> {
  const stagedResp = await admin.graphql(
    `#graphql
    mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: [
          {
            filename: file.name || `${key}.png`,
            mimeType: file.type || "image/png",
            httpMethod: "POST",
            resource: "FILE",
          },
        ],
      },
    },
  );
  const stagedJson = await stagedResp.json();
  const stagedErrors = stagedJson.data?.stagedUploadsCreate?.userErrors ?? [];
  const target = stagedJson.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (stagedErrors.length > 0 || !target) {
    throw new Error(stagedErrors[0]?.message || "Failed to prepare upload");
  }

  const uploadForm = new FormData();
  for (const param of target.parameters as { name: string; value: string }[]) {
    uploadForm.append(param.name, param.value);
  }
  uploadForm.append("file", file);

  const uploadResp = await fetch(target.url, { method: "POST", body: uploadForm });
  if (!uploadResp.ok) {
    throw new Error(`Upload to storage failed (${uploadResp.status})`);
  }

  const fileResp = await admin.graphql(
    `#graphql
    mutation CertificateFileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          ... on MediaImage { image { url } }
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        files: [{ alt: key, contentType: "IMAGE", originalSource: target.resourceUrl }],
      },
    },
  );
  const fileJson = await fileResp.json();
  const createErrors = fileJson.data?.fileCreate?.userErrors ?? [];
  const created = fileJson.data?.fileCreate?.files?.[0];
  if (createErrors.length > 0 || !created) {
    throw new Error(createErrors[0]?.message || "Failed to register uploaded file");
  }

  // Shopify processes uploaded images asynchronously — the CDN url is
  // sometimes back immediately, otherwise poll briefly until it is.
  let imageUrl: string | null = created.image?.url ?? null;
  for (let attempt = 0; !imageUrl && attempt < 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const nodeResp = await admin.graphql(
      `#graphql
      query CertificateAssetFile($id: ID!) {
        node(id: $id) {
          ... on MediaImage { image { url } }
        }
      }`,
      { variables: { id: created.id } },
    );
    const nodeJson = await nodeResp.json();
    imageUrl = nodeJson.data?.node?.image?.url ?? null;
  }

  if (!imageUrl) {
    throw new Error("Upload succeeded but the image is still processing — try again shortly");
  }

  await db.certificateAsset.upsert({
    where: { shop_key: { shop, key } },
    create: { shop, key, url: imageUrl },
    update: { url: imageUrl },
  });

  return imageUrl;
}
