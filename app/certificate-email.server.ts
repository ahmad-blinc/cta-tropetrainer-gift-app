import db from "./db.server";

export const DEFAULT_EMAIL_LINK_TEXT = "Download Your Gift Certificate";

export type CertificateEmailSettings = {
  headingText: string;
  linkText: string;
};

export async function getCertificateEmailSettings(shop: string): Promise<CertificateEmailSettings> {
  const record = await db.certificateEmailSettings.findUnique({ where: { shop } });
  return {
    headingText: record?.headingText ?? "",
    linkText: record?.linkText ?? DEFAULT_EMAIL_LINK_TEXT,
  };
}

export async function saveCertificateEmailSettings(
  shop: string,
  settings: CertificateEmailSettings,
): Promise<void> {
  await db.certificateEmailSettings.upsert({
    where: { shop },
    create: { shop, headingText: settings.headingText || null, linkText: settings.linkText },
    update: { headingText: settings.headingText || null, linkText: settings.linkText },
  });
}
