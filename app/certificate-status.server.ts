import db from "./db.server";

export type ContactLinkVisibility = "processing" | "delayed" | "both";

export const DEFAULT_STATUS_MESSAGES = {
  processingHeading: "Your certificate is being processed",
  processingBody:
    "Please try refreshing this page, or reopen this link again in 2–3 minutes.",
  delayedHeading: "Your certificate is taking longer than expected",
  delayedBody: "Please contact us and we'll help sort this out right away.",
  contactLink: "",
  contactLinkVisibility: "delayed" as ContactLinkVisibility,
};

export type CertificateStatusMessages = typeof DEFAULT_STATUS_MESSAGES;

export async function getCertificateStatusMessages(
  shop: string,
): Promise<CertificateStatusMessages> {
  const record = await db.certificateStatusMessages.findUnique({ where: { shop } });
  if (!record) return DEFAULT_STATUS_MESSAGES;
  return {
    processingHeading: record.processingHeading,
    processingBody: record.processingBody,
    delayedHeading: record.delayedHeading,
    delayedBody: record.delayedBody,
    contactLink: record.contactLink ?? "",
    contactLinkVisibility: (record.contactLinkVisibility as ContactLinkVisibility) ?? "delayed",
  };
}

export async function saveCertificateStatusMessages(
  shop: string,
  messages: CertificateStatusMessages,
): Promise<void> {
  await db.certificateStatusMessages.upsert({
    where: { shop },
    create: { shop, ...messages, contactLink: messages.contactLink || null },
    update: { ...messages, contactLink: messages.contactLink || null },
  });
}

// Accepts either a bare email address or a full URL and returns something
// safe to drop straight into an href — mailto: for an email, passed through
// unchanged for anything that already looks like a URL.
export function resolveContactHref(contactLink: string): string | null {
  const trimmed = contactLink.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return `mailto:${trimmed}`;
  return `https://${trimmed}`;
}

export function shouldShowContactLink(
  visibility: ContactLinkVisibility,
  delayed: boolean,
): boolean {
  if (visibility === "both") return true;
  return visibility === "delayed" ? delayed : !delayed;
}
