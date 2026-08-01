/**
 * Verify App Store signed transaction JWS (StoreKit 2).
 *
 * 1. Parse compact JWS (ES256 + x5c)
 * 2. Validate x5c chain anchors to pinned Apple Root CA - G3
 * 3. Verify JWS signature with leaf public key (jose)
 * 4. Validate transaction claims
 *
 * Privacy: never log raw JWS or payload bodies.
 */

import { X509Certificate } from 'node:crypto';

import { compactVerify, importX509 } from 'jose';

import { APPLE_ROOT_CA_G3_PEM, APPLE_ROOT_CA_G3_SHA256 } from './apple-root-ca';

export type AppleEnvironment = 'Sandbox' | 'Production' | 'Xcode';

export type VerifiedAppleTransaction = {
  originalTransactionId: string;
  transactionId: string;
  productId: string;
  bundleId: string;
  purchaseDate: number;
  expiresDate: number;
  revocationDate?: number;
  environment: AppleEnvironment;
  type: string;
};

export type JwsVerifyErrorCode
  = | 'malformed'
    | 'bad_alg'
    | 'bad_chain'
    | 'bad_signature'
    | 'bad_claims'
    | 'expired'
    | 'revoked'
    | 'wrong_bundle'
    | 'wrong_product';

export class JwsVerifyError extends Error {
  readonly code: JwsVerifyErrorCode;
  constructor(code: JwsVerifyErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'JwsVerifyError';
  }
}

export type JwsVerifyOptions = {
  allowedBundleIds: readonly string[];
  allowedProductIds: readonly string[];
  allowSandbox?: boolean;
  acceptExpired?: boolean;
  acceptRevoked?: boolean;
  nowMs?: number;
};

function b64urlToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}

function derB64ToPem(derB64: string): string {
  const clean = derB64.replace(/\s+/g, '');
  const lines = clean.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

function normalizeFp(fp: string): string {
  return fp.replace(/:/g, '').toLowerCase();
}

/**
 * Validate x5c chain and return leaf PEM for JWS verify.
 * Chain must link leaf → intermediate(s) → Apple Root CA G3.
 */
function verifyChainToAppleRoot(x5c: string[]): string {
  if (!Array.isArray(x5c) || x5c.length < 2)
    throw new JwsVerifyError('bad_chain', 'x5c chain too short');

  let certs: X509Certificate[];
  try {
    certs = x5c.map(der => new X509Certificate(Buffer.from(der, 'base64')));
  }
  catch {
    throw new JwsVerifyError('bad_chain', 'invalid x5c certificate');
  }

  const root = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
  if (normalizeFp(root.fingerprint256) !== APPLE_ROOT_CA_G3_SHA256)
    throw new JwsVerifyError('bad_chain', 'pinned root mismatch');

  // Each cert (except last) must be signed by the next in the chain.
  for (let i = 0; i < certs.length - 1; i++) {
    const child = certs[i]!;
    const issuer = certs[i + 1]!;
    try {
      if (!child.verify(issuer.publicKey))
        throw new Error('verify false');
    }
    catch {
      throw new JwsVerifyError('bad_chain', 'certificate chain verify failed');
    }
  }

  const last = certs[certs.length - 1]!;
  const lastFp = normalizeFp(last.fingerprint256);
  if (lastFp === APPLE_ROOT_CA_G3_SHA256) {
    // Chain includes Apple root — OK
  }
  else {
    // Last is intermediate; must be signed by pinned root
    try {
      if (!last.verify(root.publicKey))
        throw new Error('verify false');
    }
    catch {
      throw new JwsVerifyError('bad_chain', 'chain does not anchor to Apple Root CA G3');
    }
  }

  // Leaf must still be within validity window (best-effort; JWS may be older).
  const leaf = certs[0]!;
  const now = Date.now();
  const from = Date.parse(leaf.validFrom);
  const to = Date.parse(leaf.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now > to)
    throw new JwsVerifyError('bad_chain', 'leaf certificate not valid at current time');

  return derB64ToPem(x5c[0]!);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v))
    return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
    return Number(v);
  return null;
}

/** Verify an Apple ES256/x5c compact JWS and return its JSON payload. */
export async function verifyAppleSignedJws(token: string): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3)
    throw new JwsVerifyError('malformed', 'not a compact JWS');

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]!))) as Record<string, unknown>;
  }
  catch {
    throw new JwsVerifyError('malformed', 'bad JWS header');
  }

  if (header.alg !== 'ES256')
    throw new JwsVerifyError('bad_alg', 'alg must be ES256');

  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.some(c => typeof c !== 'string'))
    throw new JwsVerifyError('bad_chain', 'missing x5c');

  const leafPem = verifyChainToAppleRoot(x5c as string[]);

  let payloadBytes: Uint8Array;
  try {
    const key = await importX509(leafPem, 'ES256');
    const verified = await compactVerify(token, key, { algorithms: ['ES256'] });
    payloadBytes = verified.payload;
  }
  catch {
    throw new JwsVerifyError('bad_signature', 'JWS signature invalid');
  }

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes)) as unknown;
  }
  catch {
    throw new JwsVerifyError('malformed', 'bad JWS payload');
  }
  if (claims == null || typeof claims !== 'object' || Array.isArray(claims))
    throw new JwsVerifyError('malformed', 'JWS payload must be an object');
  return claims as Record<string, unknown>;
}

/**
 * Verify a StoreKit 2 transaction JWS and return normalized claims.
 */
export async function verifyAppleTransactionJws(
  token: string,
  opts: JwsVerifyOptions,
): Promise<VerifiedAppleTransaction> {
  const claims = await verifyAppleSignedJws(token);

  const bundleId = str(claims.bundleId);
  const productId = str(claims.productId);
  const originalTransactionId = str(claims.originalTransactionId);
  const transactionId = str(claims.transactionId) ?? originalTransactionId;
  const type = str(claims.type) ?? '';
  const environmentRaw = str(claims.environment) ?? 'Production';
  const expiresDate = num(claims.expiresDate);
  const purchaseDate = num(claims.purchaseDate);
  const revocationDate = num(claims.revocationDate);
  const nowMs = opts.nowMs ?? Date.now();

  if (!bundleId || !productId || !originalTransactionId || expiresDate == null || purchaseDate == null)
    throw new JwsVerifyError('bad_claims', 'missing required transaction claims');

  if (!opts.allowedBundleIds.includes(bundleId))
    throw new JwsVerifyError('wrong_bundle', 'bundleId not allowed');

  if (!opts.allowedProductIds.includes(productId))
    throw new JwsVerifyError('wrong_product', 'productId not allowed');

  const environment = environmentRaw as AppleEnvironment;
  if (environment === 'Xcode')
    throw new JwsVerifyError('bad_claims', 'Xcode StoreKit Testing JWS not accepted');
  if (environment === 'Sandbox' && opts.allowSandbox === false)
    throw new JwsVerifyError('bad_claims', 'Sandbox not allowed');
  if (environment !== 'Sandbox' && environment !== 'Production')
    throw new JwsVerifyError('bad_claims', 'unknown environment');

  if (type && type !== 'Auto-Renewable Subscription')
    throw new JwsVerifyError('bad_claims', 'not an auto-renewable subscription');

  if (expiresDate <= nowMs && opts.acceptExpired !== true)
    throw new JwsVerifyError('expired', 'subscription expired');
  if (revocationDate != null && revocationDate <= nowMs && opts.acceptRevoked !== true)
    throw new JwsVerifyError('revoked', 'subscription revoked');

  return {
    originalTransactionId,
    transactionId: transactionId ?? originalTransactionId,
    productId,
    bundleId,
    purchaseDate,
    expiresDate,
    revocationDate: revocationDate ?? undefined,
    environment,
    type: type || 'Auto-Renewable Subscription',
  };
}

/** True when the bearer looks like a compact JWS (three base64url segments). */
export function looksLikeJws(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every(p => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}
