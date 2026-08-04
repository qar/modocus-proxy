/**
 * Apple DeviceCheck two-bit state for the free voice teaser.
 *
 * The per-install ledger alone resets on reinstall; DeviceCheck's two bits
 * survive reinstalls, so bit0 marks "teaser exhausted this month". Missing
 * configuration or Apple errors degrade to permissive: the teaser is worth
 * cents per device per month, so availability wins over enforcement
 * (monetization.md §5).
 *
 * Privacy: the device token is forwarded to Apple for validation and never
 * stored or logged.
 */

export type DeviceCheckEnv = {
  /** PKCS8 PEM of the .p8 DeviceCheck key (single line with \n escapes ok). */
  DEVICECHECK_KEY_P8?: string;
  DEVICECHECK_KEY_ID?: string;
  APPLE_TEAM_ID?: string;
  /** Override for tests; defaults to the production endpoint. */
  DEVICECHECK_BASE_URL?: string;
};

export type DeviceBits = {
  bit0: boolean;
  bit1: boolean;
  /** Apple's "YYYY-MM" last-update marker; null when the device has no state. */
  lastUpdated: string | null;
};

export function isDeviceCheckConfigured(env: DeviceCheckEnv): boolean {
  return Boolean(
    env.DEVICECHECK_KEY_P8?.trim()
    && env.DEVICECHECK_KEY_ID?.trim()
    && env.APPLE_TEAM_ID?.trim(),
  );
}

function baseUrl(env: DeviceCheckEnv): string {
  return (env.DEVICECHECK_BASE_URL?.trim() || 'https://api.devicecheck.apple.com')
    .replace(/\/+$/, '');
}

function pemToPkcs8Bytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes)
    s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deviceCheckJwt(env: DeviceCheckEnv): Promise<string> {
  const header = { alg: 'ES256', kid: env.DEVICECHECK_KEY_ID };
  const payload = { iss: env.APPLE_TEAM_ID, iat: Math.floor(Date.now() / 1000) };
  const enc = new TextEncoder();
  const signingInput = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8Bytes(env.DEVICECHECK_KEY_P8 ?? ''),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

async function callDeviceCheck(
  env: DeviceCheckEnv,
  path: '/v1/query_two_bits' | '/v1/update_two_bits',
  body: Record<string, unknown>,
): Promise<Response> {
  const jwt = await deviceCheckJwt(env);
  return fetch(`${baseUrl(env)}${path}`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${jwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...body,
      transaction_id: crypto.randomUUID(),
      timestamp: Date.now(),
    }),
  });
}

/**
 * Query the device's two bits. Returns null when DeviceCheck is not
 * configured, the token is invalid, or Apple is unreachable — callers must
 * treat null as "no signal", not as "not exhausted".
 */
export async function queryDeviceBits(
  env: DeviceCheckEnv,
  deviceToken: string,
): Promise<DeviceBits | null> {
  if (!isDeviceCheckConfigured(env) || deviceToken.length === 0)
    return null;
  try {
    const res = await callDeviceCheck(env, '/v1/query_two_bits', {
      device_token: deviceToken,
    });
    // Apple returns 200 with an empty body when the device has no bits yet.
    if (!res.ok)
      return null;
    const text = await res.text();
    if (text.trim().length === 0)
      return { bit0: false, bit1: false, lastUpdated: null };
    const parsed = JSON.parse(text) as {
      bit0?: unknown;
      bit1?: unknown;
      last_update_time?: unknown;
    };
    return {
      bit0: parsed.bit0 === true,
      bit1: parsed.bit1 === true,
      lastUpdated: typeof parsed.last_update_time === 'string' ? parsed.last_update_time : null,
    };
  }
  catch {
    return null;
  }
}

/** Set bit0 (teaser exhausted marker). Best effort; failures are swallowed. */
export async function markDeviceExhausted(
  env: DeviceCheckEnv,
  deviceToken: string,
  exhausted: boolean,
): Promise<void> {
  if (!isDeviceCheckConfigured(env) || deviceToken.length === 0)
    return;
  try {
    await callDeviceCheck(env, '/v1/update_two_bits', {
      device_token: deviceToken,
      bit0: exhausted,
      bit1: false,
    });
  }
  catch {
    // best effort
  }
}

/** Apple's last_update_time is "YYYY-MM" (UTC). */
export function isSameUtcMonth(lastUpdated: string | null, nowMs: number): boolean {
  if (!lastUpdated)
    return false;
  const now = new Date(nowMs);
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return lastUpdated === current;
}
