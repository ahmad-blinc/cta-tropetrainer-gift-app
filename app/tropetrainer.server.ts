const DEFAULT_TROPETRAINER_API_URL = "https://www.tropetrainer.com/api/access-codes";
const TROPETRAINER_API_URL = process.env.TROPETRAINER_API_URL || DEFAULT_TROPETRAINER_API_URL;

export function getTropeTrainerConnectionStatus() {
  return {
    apiKeyConfigured: Boolean(process.env.TROPETRAINER_API_KEY),
    apiUrl: TROPETRAINER_API_URL,
    isDefaultUrl: TROPETRAINER_API_URL === DEFAULT_TROPETRAINER_API_URL,
  };
}

export type AccessCodeResult =
  | {
      ok: true;
      code: string;
      accessCodeId: string;
      status: string;
      requestId: string | null;
    }
  | {
      ok: false;
      message: string;
      errorCode: string | null;
      retryable: boolean;
      requestId: string | null;
      retryAfterSeconds: number | null;
    };

function failure(
  message: string,
  opts: Partial<{
    errorCode: string | null;
    retryable: boolean;
    requestId: string | null;
    retryAfterSeconds: number | null;
  }> = {},
): AccessCodeResult {
  return {
    ok: false,
    message,
    errorCode: opts.errorCode ?? null,
    retryable: opts.retryable ?? false,
    requestId: opts.requestId ?? null,
    retryAfterSeconds: opts.retryAfterSeconds ?? null,
  };
}

// Never log the Authorization header or the full access code — both are secrets
// per TropeTrainer's API terms.
export async function createAccessCode(
  idempotencyKey: string,
): Promise<AccessCodeResult> {
  const apiKey = process.env.TROPETRAINER_API_KEY;
  if (!apiKey) {
    return failure("TROPETRAINER_API_KEY is not configured");
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
    // Network/timeout failures are retryable per spec — a timeout doesn't mean
    // the purchase failed, retrying with the same key returns the authoritative result.
    return failure(
      `Network error calling TropeTrainer API: ${(err as Error).message}`,
      { retryable: true },
    );
  }

  const headerRequestId = response.headers.get("x-request-id");
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : null;

  if (!response.ok) {
    // Per spec, an upstream failure can return a non-JSON 5xx body — tolerate that.
    const parsed = await response.json().catch(() => null);
    const errorObj = parsed?.error;

    if (errorObj) {
      // Code against error.code, not message, per spec.
      return failure(errorObj.message || `TropeTrainer API returned ${response.status}`, {
        errorCode: errorObj.code ?? null,
        retryable: Boolean(errorObj.retryable),
        requestId: errorObj.request_id ?? headerRequestId,
        retryAfterSeconds,
      });
    }

    // Non-JSON or unrecognized error body — treat 5xx as retryable, everything else not.
    return failure(`TropeTrainer API returned ${response.status} with no parseable error body`, {
      retryable: response.status >= 500,
      requestId: headerRequestId,
      retryAfterSeconds,
    });
  }

  const data = await response.json();
  return {
    ok: true,
    code: data.code,
    accessCodeId: data.id,
    status: data.status,
    requestId: headerRequestId,
  };
}
