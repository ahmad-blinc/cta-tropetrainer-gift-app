const TROPETRAINER_API_URL = "https://www.tropetrainer.com/api/access-codes";

export type AccessCodeResult =
  | {
      ok: true;
      code: string;
      accessCodeId: string;
      status: string;
      requestId: string | null;
    }
  | { ok: false; error: string };

// Never log the Authorization header or the full access code — both are secrets
// per TropeTrainer's API terms.
export async function createAccessCode(
  idempotencyKey: string,
): Promise<AccessCodeResult> {
  const apiKey = process.env.TROPETRAINER_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "TROPETRAINER_API_KEY is not configured" };
  }

  let response: Response;
  try {
    response = await fetch(TROPETRAINER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Idempotency-Key": idempotencyKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Network error calling TropeTrainer API: ${(err as Error).message}`,
    };
  }

  const requestId = response.headers.get("x-request-id");

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      ok: false,
      error: `TropeTrainer API returned ${response.status}: ${bodyText.slice(0, 500)}`,
    };
  }

  const data = await response.json();
  return {
    ok: true,
    code: data.code,
    accessCodeId: data.id,
    status: data.status,
    requestId,
  };
}
