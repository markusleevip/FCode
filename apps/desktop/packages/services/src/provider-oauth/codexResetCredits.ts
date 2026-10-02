import { randomUUID } from "node:crypto";
import { FCODE_VERSION } from "@fcode/shared";
import type { ProviderOAuthResetCredit } from "./contract.js";
import { object, string, ProviderOAuthTransport, type OAuthObject } from "./protocolTransport.js";
import { ProviderOAuthError, type ProviderOAuthAccount } from "./types.js";

// Both endpoints are unpublished ChatGPT backend APIs; parsing stays lenient and a credit is only
// dropped when the payload positively says it cannot be used.
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const RESET_CREDITS_CONSUME_URL = `${RESET_CREDITS_URL}/consume`;
const MAX_CREDITS = 64;
const CODEX_RESET_TYPE = "codex_rate_limits";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const MIN_RENEWAL_MS = Date.UTC(2000, 0, 1);
const MAX_RENEWAL_MS = Date.UTC(2100, 0, 1);

export type CodexResetOutcome = "reset" | "nothing_to_reset";

function codexHeaders(account: ProviderOAuthAccount): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${account.tokens.accessToken}`,
    "user-agent": `FCode/${FCODE_VERSION}`,
    originator: "fcode",
    "openai-beta": "codex-1",
  };
  if (account.tokens.accountIdentity)
    headers["ChatGPT-Account-Id"] = account.tokens.accountIdentity;
  return headers;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch seconds and milliseconds are both seen in the wild.
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const text = string(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Usable credits only, earliest expiry first; unknown fields never exclude a credit. */
export function projectCodexResetCredits(
  payload: OAuthObject,
  now = Date.now(),
): ProviderOAuthResetCredit[] {
  const entries = Array.isArray(payload.credits) ? payload.credits.slice(0, MAX_CREDITS) : [];
  const credits: ProviderOAuthResetCredit[] = [];
  for (const raw of entries) {
    const credit = object(raw);
    const id = string(credit.id);
    if (!id || string(credit.status) !== "available") continue;
    const resetType = string(credit.reset_type);
    if (resetType && resetType !== CODEX_RESET_TYPE) continue;
    if (credit.is_supported_by_plan === false) continue;
    const expiresAt = parseTime(credit.expires_at);
    if (expiresAt !== undefined && expiresAt <= now) continue;
    credits.push({ id, ...(expiresAt !== undefined ? { expiresAt } : {}) });
  }
  return credits.sort(
    (left, right) =>
      (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY),
  );
}

/** Subscription renewal time from the id_token claim; undefined when absent or implausible. */
export function readCodexSubscriptionRenewal(idToken: string | undefined): number | undefined {
  if (!idToken) return undefined;
  try {
    const claims = object(
      JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")),
    );
    const renewal = parseTime(object(claims[OPENAI_AUTH_CLAIM]).chatgpt_subscription_active_until);
    return renewal !== undefined && renewal >= MIN_RENEWAL_MS && renewal <= MAX_RENEWAL_MS
      ? renewal
      : undefined;
  } catch {
    return undefined;
  }
}

export async function queryCodexResetCredits(
  transport: ProviderOAuthTransport,
  account: ProviderOAuthAccount,
  signal: AbortSignal,
): Promise<ProviderOAuthResetCredit[]> {
  const payload = await transport.request(
    RESET_CREDITS_URL,
    { method: "GET", headers: codexHeaders(account) },
    signal,
  );
  return projectCodexResetCredits(payload);
}

/**
 * Spends one reset credit. Fail-closed: without a confirmed available credit nothing is sent, and
 * an unrecognised answer is reported as an error so the user re-checks the count before retrying.
 * Never retried automatically; a lost response after a successful redeem could otherwise spend a
 * second credit.
 */
export async function redeemCodexResetCredit(
  transport: ProviderOAuthTransport,
  account: ProviderOAuthAccount,
  requestedCreditId: string | undefined,
  signal: AbortSignal,
): Promise<CodexResetOutcome> {
  const credits = await queryCodexResetCredits(transport, account, signal);
  const credit = requestedCreditId
    ? credits.find((item) => item.id === requestedCreditId)
    : credits[0];
  if (!credit) throw new ProviderOAuthError("no_reset_credit");
  const payload = await transport.json(
    RESET_CREDITS_CONSUME_URL,
    { credit_id: credit.id, redeem_request_id: randomUUID() },
    signal,
    codexHeaders(account),
  );
  switch (string(payload.code)) {
    case "reset":
    case "already_redeemed":
      return "reset";
    case "no_credit":
    case "nothing_to_reset":
      return "nothing_to_reset";
    default:
      throw new ProviderOAuthError("unexpected_reset_response");
  }
}

/** Uses the Host's network entry point; account refresh, re-checks and caching stay with the runtime. */
export function createProviderOAuthUsageReset(options: { fetch: typeof fetch }) {
  const transport = new ProviderOAuthTransport(options.fetch);
  return async (
    account: ProviderOAuthAccount,
    creditId: string | undefined,
    signal: AbortSignal,
  ): Promise<CodexResetOutcome> => {
    if (signal.aborted) throw new ProviderOAuthError("cancelled");
    if (account.supplier !== "codex") throw new ProviderOAuthError("unsupported_usage");
    return redeemCodexResetCredit(transport, account, creditId, signal);
  };
}
