/**
 * Proxy authentication.
 *
 * production: Apple StoreKit 2 transaction JWS only. Anonymous / short
 *             bearers rejected. DEV_BYPASS ignored even if the secret exists.
 * staging:    DEV_BYPASS_TOKEN allowed (exact match). JWS also accepted for
 *             real Sandbox purchases.
 */

import {
  JwsVerifyError,
  looksLikeJws,
  verifyAppleTransactionJws,
  type VerifiedAppleTransaction,
} from './apple-jws';

export type AuthEnv = {
  ENVIRONMENT?: string;
  DEV_BYPASS_TOKEN?: string;
  ALLOWED_BUNDLE_IDS?: string;
  ALLOWED_PRODUCT_IDS?: string;
  SUBJECT_HASH_SALT?: string;
  /** "true" | "false" — default true (TestFlight). */
  ALLOW_SANDBOX?: string;
};

export type AuthSuccess = {
  ok: true;
  /** Salted hash used for quota and metrics; never a raw transaction id. */
  subject: string;
  periodStartMs: number;
  periodEndMs: number;
  kind: 'jws' | 'dev_bypass';
  transaction?: VerifiedAppleTransaction;
};

export type AuthFailure = {
  ok: false;
  status: 401 | 403;
  code: string;
  message: string;
};

export type AuthResult = AuthSuccess | AuthFailure;

export const DEFAULT_BUNDLES = [
  'app.modocus',
  'app.modocus.preview',
  'app.modocus.development',
] as const;

export const DEFAULT_PRODUCTS = [
  'app.modocus.ai.monthly',
] as const;

export function parseConfiguredList(raw: string | undefined, fallback: readonly string[]): string[] {
  if (!raw || raw.trim() === '')
    return [...fallback];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export async function subscriptionSubject(
  originalTransactionId: string,
  salt: string,
): Promise<string> {
  return `sub:${await sha256Hex(`${salt}:${originalTransactionId}`)}`;
}

export function isStaging(env: AuthEnv): boolean {
  return (env.ENVIRONMENT ?? 'production').toLowerCase() === 'staging';
}

/**
 * Authenticate a Bearer credential.
 * Never logs the token.
 */
export async function authenticateBearer(
  env: AuthEnv,
  token: string | null,
): Promise<AuthResult> {
  if (!token || token.length === 0) {
    return {
      ok: false,
      status: 401,
      code: 'auth',
      message: 'missing_bearer',
    };
  }

  // Staging-only dogfood bypass — exact match, constant-time-ish compare.
  if (isStaging(env) && env.DEV_BYPASS_TOKEN && env.DEV_BYPASS_TOKEN.length >= 16) {
    if (timingSafeEqual(token, env.DEV_BYPASS_TOKEN)) {
      const now = new Date();
      const periodStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      const periodEndMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      return {
        ok: true,
        subject: `bypass:${await sha256Hex(`${env.SUBJECT_HASH_SALT ?? 'staging'}:${token}`)}`,
        periodStartMs,
        periodEndMs,
        kind: 'dev_bypass',
      };
    }
  }

  // Production (and staging without bypass match): require Apple JWS.
  if (!looksLikeJws(token)) {
    return {
      ok: false,
      status: 401,
      code: 'auth',
      message: 'jws_required',
    };
  }

  try {
    const tx = await verifyAppleTransactionJws(token, {
      allowedBundleIds: parseConfiguredList(env.ALLOWED_BUNDLE_IDS, DEFAULT_BUNDLES),
      allowedProductIds: parseConfiguredList(env.ALLOWED_PRODUCT_IDS, DEFAULT_PRODUCTS),
      allowSandbox: env.ALLOW_SANDBOX !== 'false',
    });
    if (!env.SUBJECT_HASH_SALT || env.SUBJECT_HASH_SALT.length < 16) {
      return {
        ok: false,
        status: 403,
        code: 'server_configuration',
        message: 'subject_hash_salt_missing',
      };
    }
    return {
      ok: true,
      subject: await subscriptionSubject(tx.originalTransactionId, env.SUBJECT_HASH_SALT),
      periodStartMs: tx.purchaseDate,
      periodEndMs: tx.expiresDate,
      kind: 'jws',
      transaction: tx,
    };
  }
  catch (err) {
    if (err instanceof JwsVerifyError) {
      const status = err.code === 'expired' || err.code === 'revoked' || err.code === 'wrong_product' || err.code === 'wrong_bundle'
        ? 403
        : 401;
      return {
        ok: false,
        status,
        code: err.code,
        message: err.message,
      };
    }
    return {
      ok: false,
      status: 401,
      code: 'auth',
      message: 'verify_failed',
    };
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length)
    return false;
  let out = 0;
  for (let i = 0; i < a.length; i++)
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
