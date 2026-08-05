export const DEFAULT_OPERATION_LIMIT = 400;

/**
 * Free teaser ops per device per UTC month, shared across voice capture,
 * Assistant chat, and task insight (monetization.md §5).
 */
export const FREE_TEASER_OPERATION_LIMIT = 30;

export type ReserveOperationInput = {
  operationId: string;
  periodStartMs: number;
  periodEndMs: number;
  limit?: number;
};

export type ReserveOperationResult = {
  allowed: boolean;
  counted: boolean;
  used: number;
  limit: number;
  periodEndMs: number;
};

export type TransactionRevocationInput = {
  transactionHash: string;
  revoked: boolean;
  revokedAtMs?: number;
};

export type TransactionRevocationStatus = {
  revoked: boolean;
  revokedAtMs?: number;
};

export type LedgerTransaction = {
  get<T>(key: string): Promise<T | undefined>;
  list(): Promise<Map<string, unknown>>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
};

export type LedgerStorage = {
  transaction<T>(callback: (txn: LedgerTransaction) => Promise<T>): Promise<T>;
};

const PERIOD_KEY = 'currentPeriod';
const COUNT_KEY = 'operationCount';
const OPERATION_PREFIX = 'op:';
const REVOCATION_PREFIX = 'revoked:';

export function isValidOperationId(value: string | null): value is string {
  return typeof value === 'string'
    && value.length >= 16
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function validInput(input: ReserveOperationInput): boolean {
  return isValidOperationId(input.operationId)
    && Number.isFinite(input.periodStartMs)
    && Number.isFinite(input.periodEndMs)
    && input.periodStartMs > 0
    && input.periodEndMs > input.periodStartMs;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function validTransactionHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export async function setTransactionRevocation(
  storage: LedgerStorage,
  input: TransactionRevocationInput,
): Promise<TransactionRevocationStatus> {
  if (!validTransactionHash(input.transactionHash))
    throw new Error('invalid_transaction_hash');
  const key = `${REVOCATION_PREFIX}${input.transactionHash}`;
  return storage.transaction(async (txn) => {
    const eventAtMs = Number.isFinite(input.revokedAtMs) && (input.revokedAtMs ?? 0) > 0
      ? input.revokedAtMs!
      : Date.now();
    const current = parseRevocationState(await txn.get<unknown>(key));
    if (
      current
      && (current.updatedAtMs > eventAtMs
        || (current.updatedAtMs === eventAtMs && (!current.revoked || input.revoked)))
    ) {
      return current.revoked
        ? { revoked: true, revokedAtMs: current.updatedAtMs }
        : { revoked: false };
    }
    await txn.put({ [key]: { revoked: input.revoked, updatedAtMs: eventAtMs } });
    return input.revoked
      ? { revoked: true, revokedAtMs: eventAtMs }
      : { revoked: false };
  });
}

function parseRevocationState(value: unknown): { revoked: boolean; updatedAtMs: number } | null {
  // Backward compatibility with the original numeric revoked-at record.
  if (typeof value === 'number' && Number.isFinite(value))
    return { revoked: true, updatedAtMs: value };
  if (value == null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const record = value as { revoked?: unknown; updatedAtMs?: unknown };
  return typeof record.revoked === 'boolean'
    && typeof record.updatedAtMs === 'number'
    && Number.isFinite(record.updatedAtMs)
    ? { revoked: record.revoked, updatedAtMs: record.updatedAtMs }
    : null;
}

export async function getTransactionRevocation(
  storage: LedgerStorage,
  transactionHash: string,
): Promise<TransactionRevocationStatus> {
  if (!validTransactionHash(transactionHash))
    throw new Error('invalid_transaction_hash');
  return storage.transaction(async (txn) => {
    const state = parseRevocationState(await txn.get<unknown>(`${REVOCATION_PREFIX}${transactionHash}`));
    return state?.revoked
      ? { revoked: true, revokedAtMs: state.updatedAtMs }
      : { revoked: false };
  });
}

/** Remove expired period counters while preserving refund/revocation records. */
export async function clearExpiredQuota(
  storage: LedgerStorage,
  nowMs: number = Date.now(),
): Promise<boolean> {
  return storage.transaction(async (txn) => {
    const currentPeriod = await txn.get<string>(PERIOD_KEY);
    const periodEndMs = Number(currentPeriod?.split(':')[1]);
    if (!Number.isFinite(periodEndMs) || periodEndMs > nowMs)
      return false;
    const previous = await txn.list();
    const quotaKeys = [...previous.keys()].filter(key =>
      key === PERIOD_KEY || key === COUNT_KEY || key.startsWith(OPERATION_PREFIX),
    );
    if (quotaKeys.length > 0)
      await txn.delete(quotaKeys);
    return quotaKeys.length > 0;
  });
}

export async function reserveOperation(
  storage: LedgerStorage,
  input: ReserveOperationInput,
): Promise<ReserveOperationResult> {
  if (!validInput(input))
    throw new Error('invalid_reservation');
  const limit = Number.isInteger(input.limit) && (input.limit ?? 0) > 0
    ? input.limit!
    : DEFAULT_OPERATION_LIMIT;
  const period = `${input.periodStartMs}:${input.periodEndMs}`;
  const operationKey = `${OPERATION_PREFIX}${await sha256Hex(input.operationId)}`;

  return storage.transaction(async (txn) => {
    const currentPeriod = await txn.get<string>(PERIOD_KEY);
    if (currentPeriod !== period) {
      const previous = await txn.list();
      const quotaKeys = [...previous.keys()].filter(key =>
        key === PERIOD_KEY || key === COUNT_KEY || key.startsWith(OPERATION_PREFIX),
      );
      if (quotaKeys.length > 0)
        await txn.delete(quotaKeys);
      await txn.put({ [PERIOD_KEY]: period });
    }

    const existing = await txn.get<number>(operationKey);
    if (typeof existing === 'number') {
      const currentUsed = await txn.get<number>(COUNT_KEY);
      return {
        allowed: true,
        counted: false,
        used: Math.max(existing, currentUsed ?? 0),
        limit,
        periodEndMs: input.periodEndMs,
      };
    }

    const used = await txn.get<number>(COUNT_KEY) ?? 0;
    if (used >= limit) {
      return {
        allowed: false,
        counted: false,
        used,
        limit,
        periodEndMs: input.periodEndMs,
      };
    }

    const next = used + 1;
    await txn.put({
      [COUNT_KEY]: next,
      [operationKey]: next,
    });
    return {
      allowed: true,
      counted: true,
      used: next,
      limit,
      periodEndMs: input.periodEndMs,
    };
  });
}

export class UsageLedger {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST')
      return Response.json({ error: 'not_found' }, { status: 404 });

    if (url.pathname === '/subscription/status') {
      try {
        const input = await request.json() as { transactionHash?: unknown };
        const result = await getTransactionRevocation(this.state.storage, String(input.transactionHash ?? ''));
        return Response.json(result);
      }
      catch {
        return Response.json({ error: 'invalid_transaction_hash' }, { status: 400 });
      }
    }

    if (url.pathname === '/subscription/revocation') {
      try {
        const input = await request.json() as TransactionRevocationInput;
        const result = await setTransactionRevocation(this.state.storage, input);
        return Response.json(result);
      }
      catch {
        return Response.json({ error: 'invalid_revocation' }, { status: 400 });
      }
    }

    if (url.pathname !== '/reserve')
      return Response.json({ error: 'not_found' }, { status: 404 });

    let input: ReserveOperationInput;
    try {
      input = await request.json() as ReserveOperationInput;
    }
    catch {
      return Response.json({ error: 'invalid_reservation' }, { status: 400 });
    }

    try {
      const result = await reserveOperation(this.state.storage, input);
      await this.state.storage.setAlarm(input.periodEndMs + 60_000).catch(() => {});
      return Response.json(result);
    }
    catch {
      return Response.json({ error: 'invalid_reservation' }, { status: 400 });
    }
  }

  async alarm(): Promise<void> {
    await clearExpiredQuota(this.state.storage);
  }
}
