// Periodically syncs GiftCode.status with TropeTrainer's real record, since
// nothing else ever updates a code's status after it's minted — a redeemed
// or revoked code would otherwise show "issued" in our database forever.
// Run on a schedule (e.g. a Railway cron-triggered service); safe to run
// repeatedly, only touches rows currently marked "issued".
import { PrismaClient } from "@prisma/client";

const DEFAULT_TROPETRAINER_API_URL = "https://www.tropetrainer.com/api/access-codes";
const TROPETRAINER_API_URL = process.env.TROPETRAINER_API_URL || DEFAULT_TROPETRAINER_API_URL;
const STATUS_URL = `${TROPETRAINER_API_URL}/status`;

// The status endpoint shares a 60 req/min cap. This delay keeps us well
// under it even as the number of outstanding issued codes grows over time.
const DELAY_BETWEEN_CHECKS_MS = 1100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Never log the Authorization header or full access codes — both are
// secrets per TropeTrainer's API terms.
async function checkStatus(apiKey, idempotencyKey) {
  let response;
  try {
    response = await fetch(STATUS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ key: idempotencyKey }),
    });
  } catch (err) {
    return { ok: false, httpStatus: null, errorCode: null, message: err.message };
  }

  if (!response.ok) {
    const parsed = await response.json().catch(() => null);
    return {
      ok: false,
      httpStatus: response.status,
      errorCode: parsed?.error?.code ?? null,
      message: parsed?.error?.message ?? `HTTP ${response.status}`,
    };
  }

  const data = await response.json();
  return { ok: true, status: data.status, redeemedAt: data.redeemed_at ?? null };
}

async function main() {
  const apiKey = process.env.TROPETRAINER_API_KEY;
  if (!apiKey) {
    console.error("[sync-status] TROPETRAINER_API_KEY is not configured — nothing to do.");
    return;
  }

  const db = new PrismaClient();

  try {
    const pending = await db.giftCode.findMany({
      where: { status: "issued" },
      select: { id: true, idempotencyKey: true, shopifyOrderName: true },
    });

    console.log(`[sync-status] checking ${pending.length} issued code(s)`);

    for (const record of pending) {
      const result = await checkStatus(apiKey, record.idempotencyKey);

      if (!result.ok) {
        console.error(
          `[sync-status] order ${record.shopifyOrderName}: check failed ` +
            `(HTTP ${result.httpStatus ?? "network error"}, ${result.errorCode ?? result.message})`,
        );
        // Still record that we attempted it, so a persistently-failing
        // record doesn't silently look untouched in statusCheckedAt.
        await db.giftCode.update({
          where: { id: record.id },
          data: { statusCheckedAt: new Date() },
        }).catch(() => {});
        await sleep(DELAY_BETWEEN_CHECKS_MS);
        continue;
      }

      const updates = { statusCheckedAt: new Date() };
      if (result.status !== "issued") updates.status = result.status;
      if (result.redeemedAt) updates.redeemedAt = new Date(result.redeemedAt);

      await db.giftCode.update({ where: { id: record.id }, data: updates });

      if (result.status !== "issued") {
        console.log(`[sync-status] order ${record.shopifyOrderName}: now ${result.status}`);
      }

      await sleep(DELAY_BETWEEN_CHECKS_MS);
    }

    console.log("[sync-status] done");
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("[sync-status] fatal error:", err);
  process.exit(1);
});
