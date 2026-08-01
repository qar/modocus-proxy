import {
  DEFAULT_BUNDLES,
  DEFAULT_PRODUCTS,
  parseConfiguredList,
  subscriptionSubject,
  type AuthEnv,
} from './auth';
import {
  JwsVerifyError,
  verifyAppleSignedJws,
  verifyAppleTransactionJws,
  type VerifiedAppleTransaction,
} from './apple-jws';

export type AppStoreNotificationEnv = AuthEnv & {
  USAGE_LEDGER?: DurableObjectNamespace;
};

export type SubscriptionNotificationAction = 'revoke' | 'restore';

type NotificationData = {
  bundleId: string;
  environment: string;
  signedTransactionInfo?: string;
};

export type ParsedNotification = {
  notificationType: string;
  notificationUUID?: string;
  signedDate?: number;
  data?: NotificationData;
};

const MAX_NOTIFICATION_BYTES = 256 * 1024;

class NotificationError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 500, message: string) {
    super(message);
    this.name = 'NotificationError';
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value))
    return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

function parseNotification(payload: Record<string, unknown>): ParsedNotification {
  const notificationType = stringValue(payload.notificationType);
  if (!notificationType)
    throw new NotificationError(400, 'notification_type_missing');
  const data = object(payload.data);
  return {
    notificationType,
    notificationUUID: stringValue(payload.notificationUUID) ?? undefined,
    signedDate: numberValue(payload.signedDate),
    data: data
      ? {
          bundleId: stringValue(data.bundleId) ?? '',
          environment: stringValue(data.environment) ?? '',
          signedTransactionInfo: stringValue(data.signedTransactionInfo) ?? undefined,
        }
      : undefined,
  };
}

export function subscriptionNotificationAction(
  notificationType: string,
): SubscriptionNotificationAction | null {
  if (notificationType === 'REFUND' || notificationType === 'REVOKE')
    return 'revoke';
  if (notificationType === 'REFUND_REVERSED')
    return 'restore';
  return null;
}

export function validateNotificationTransaction(
  notification: ParsedNotification,
  transaction: VerifiedAppleTransaction,
): void {
  if (!notification.data)
    throw new NotificationError(400, 'notification_data_missing');
  if (notification.data.bundleId !== transaction.bundleId)
    throw new NotificationError(403, 'bundle_mismatch');
  if (notification.data.environment !== transaction.environment)
    throw new NotificationError(403, 'environment_mismatch');
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function transactionStateHash(subject: string, transactionId: string): Promise<string> {
  return sha256Hex(`${subject}:${transactionId}`);
}

async function updateRevocation(
  env: AppStoreNotificationEnv,
  subject: string,
  transactionId: string,
  revoked: boolean,
  revokedAtMs?: number,
): Promise<void> {
  if (!env.USAGE_LEDGER)
    throw new NotificationError(500, 'usage_ledger_missing');
  const id = env.USAGE_LEDGER.idFromName(subject);
  const response = await env.USAGE_LEDGER.get(id).fetch('https://usage-ledger/subscription/revocation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transactionHash: await transactionStateHash(subject, transactionId),
      revoked,
      revokedAtMs,
    }),
  });
  if (!response.ok)
    throw new NotificationError(500, 'revocation_store_failed');
}

export async function isTransactionRevoked(
  env: AppStoreNotificationEnv,
  subject: string,
  transactionId: string,
): Promise<boolean | null> {
  if (!env.USAGE_LEDGER)
    return null;
  const id = env.USAGE_LEDGER.idFromName(subject);
  try {
    const response = await env.USAGE_LEDGER.get(id).fetch('https://usage-ledger/subscription/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactionHash: await transactionStateHash(subject, transactionId) }),
    });
    if (!response.ok)
      return null;
    const state = await response.json() as { revoked?: unknown };
    return state.revoked === true;
  }
  catch {
    return null;
  }
}

export async function handleAppStoreNotification(
  request: Request,
  env: AppStoreNotificationEnv,
): Promise<Response> {
  try {
    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_NOTIFICATION_BYTES)
      throw new NotificationError(400, 'notification_too_large');
    const text = await request.text();
    if (text.length === 0 || text.length > MAX_NOTIFICATION_BYTES)
      throw new NotificationError(400, 'notification_size_invalid');

    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    }
    catch {
      throw new NotificationError(400, 'notification_json_invalid');
    }
    const signedPayload = stringValue(object(body)?.signedPayload);
    if (!signedPayload)
      throw new NotificationError(400, 'signed_payload_missing');

    const notification = parseNotification(await verifyAppleSignedJws(signedPayload));
    if (notification.notificationType === 'TEST')
      return json({ ok: true, test: true });

    const data = notification.data;
    if (!data)
      throw new NotificationError(400, 'notification_data_missing');
    const allowedBundles = parseConfiguredList(env.ALLOWED_BUNDLE_IDS, DEFAULT_BUNDLES);
    if (!allowedBundles.includes(data.bundleId))
      throw new NotificationError(403, 'wrong_bundle');
    if (data.environment === 'Sandbox' && env.ALLOW_SANDBOX === 'false')
      throw new NotificationError(403, 'sandbox_not_allowed');
    if (data.environment !== 'Sandbox' && data.environment !== 'Production')
      throw new NotificationError(400, 'environment_invalid');

    const action = subscriptionNotificationAction(notification.notificationType);
    if (!action)
      return json({ ok: true, ignored: true });
    if (!data.signedTransactionInfo)
      throw new NotificationError(400, 'signed_transaction_missing');

    const transaction = await verifyAppleTransactionJws(data.signedTransactionInfo, {
      allowedBundleIds: allowedBundles,
      allowedProductIds: parseConfiguredList(env.ALLOWED_PRODUCT_IDS, DEFAULT_PRODUCTS),
      allowSandbox: env.ALLOW_SANDBOX !== 'false',
      acceptExpired: true,
      acceptRevoked: true,
    });
    validateNotificationTransaction(notification, transaction);
    if (!env.SUBJECT_HASH_SALT || env.SUBJECT_HASH_SALT.length < 16)
      throw new NotificationError(500, 'subject_hash_salt_missing');

    const subject = await subscriptionSubject(
      transaction.originalTransactionId,
      env.SUBJECT_HASH_SALT,
    );
    await updateRevocation(
      env,
      subject,
      transaction.transactionId,
      action === 'revoke',
      transaction.revocationDate ?? notification.signedDate,
    );
    return json({ ok: true });
  }
  catch (error) {
    if (error instanceof NotificationError)
      return json({ ok: false, error: error.message }, error.status);
    if (error instanceof JwsVerifyError)
      return json({ ok: false, error: error.code }, 401);
    return json({ ok: false, error: 'notification_failed' }, 500);
  }
}
