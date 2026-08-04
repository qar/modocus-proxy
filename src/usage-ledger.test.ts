import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clearExpiredQuota,
  getTransactionRevocation,
  isValidOperationId,
  reserveOperation,
  setTransactionRevocation,
  type LedgerStorage,
  type LedgerTransaction,
} from './usage-ledger';

class MemoryLedgerStorage implements LedgerStorage {
  private values = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();

  transaction<T>(callback: (txn: LedgerTransaction) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => callback({
      get: async <V>(key: string) => this.values.get(key) as V | undefined,
      list: async () => new Map(this.values),
      put: async (entries: Record<string, unknown>) => {
        for (const [entryKey, entryValue] of Object.entries(entries))
          this.values.set(entryKey, entryValue);
      },
      delete: async (keys: string[]) => {
        let deleted = 0;
        for (const key of keys) {
          if (this.values.delete(key))
            deleted += 1;
        }
        return deleted;
      },
    }));
    this.tail = run.catch(() => {});
    return run;
  }
}

const PERIOD = {
  periodStartMs: 1_700_000_000_000,
  periodEndMs: 1_702_678_400_000,
};

describe('operation quota ledger', () => {
  it('counts one operation id once across internal requests and retries', async () => {
    const storage = new MemoryLedgerStorage();
    const input = { ...PERIOD, operationId: 'operation_0000000001', limit: 400 };

    const first = await reserveOperation(storage, input);
    const retry = await reserveOperation(storage, input);

    assert.deepEqual(first, {
      allowed: true,
      counted: true,
      used: 1,
      limit: 400,
      periodEndMs: PERIOD.periodEndMs,
    });
    assert.deepEqual(retry, { ...first, counted: false });
  });

  it('reports current total usage when an older operation id is retried', async () => {
    const storage = new MemoryLedgerStorage();
    await reserveOperation(storage, { ...PERIOD, operationId: 'operation_0000000001' });
    await reserveOperation(storage, { ...PERIOD, operationId: 'operation_0000000002' });

    const retry = await reserveOperation(storage, {
      ...PERIOD,
      operationId: 'operation_0000000001',
    });

    assert.equal(retry.counted, false);
    assert.equal(retry.used, 2);
  });

  it('atomically accepts exactly 400 concurrent unique operations', async () => {
    const storage = new MemoryLedgerStorage();
    const results = await Promise.all(
      Array.from({ length: 401 }, (_, index) => reserveOperation(storage, {
        ...PERIOD,
        operationId: `operation_${String(index).padStart(16, '0')}`,
        limit: 400,
      })),
    );

    assert.equal(results.filter(result => result.allowed).length, 400);
    assert.equal(results.filter(result => !result.allowed).length, 1);
    assert.equal(Math.max(...results.map(result => result.used)), 400);
  });

  it('allows operation 399 and 400, then rejects operation 401', async () => {
    const storage = new MemoryLedgerStorage();
    for (let index = 0; index < 398; index += 1) {
      await reserveOperation(storage, {
        ...PERIOD,
        operationId: `operation_${String(index).padStart(16, '0')}`,
      });
    }

    const op399 = await reserveOperation(storage, { ...PERIOD, operationId: 'operation_no_00000399' });
    const op400 = await reserveOperation(storage, { ...PERIOD, operationId: 'operation_no_00000400' });
    const op401 = await reserveOperation(storage, { ...PERIOD, operationId: 'operation_no_00000401' });

    assert.deepEqual({ allowed: op399.allowed, used: op399.used }, { allowed: true, used: 399 });
    assert.deepEqual({ allowed: op400.allowed, used: op400.used }, { allowed: true, used: 400 });
    assert.deepEqual(
      { allowed: op401.allowed, counted: op401.counted, used: op401.used },
      { allowed: false, counted: false, used: 400 },
    );
  });

  it('starts a fresh ledger when the StoreKit period changes', async () => {
    const storage = new MemoryLedgerStorage();
    await reserveOperation(storage, {
      ...PERIOD,
      operationId: 'operation_previous_period',
      limit: 1,
    });

    const next = await reserveOperation(storage, {
      periodStartMs: PERIOD.periodEndMs,
      periodEndMs: PERIOD.periodEndMs + 2_678_400_000,
      operationId: 'operation_next_period_01',
      limit: 1,
    });

    assert.equal(next.allowed, true);
    assert.equal(next.used, 1);
    assert.equal(next.counted, true);
  });

  it('preserves transaction revocations when the quota period changes', async () => {
    const storage = new MemoryLedgerStorage();
    const transactionHash = 'a'.repeat(64);
    await setTransactionRevocation(storage, {
      transactionHash,
      revoked: true,
      revokedAtMs: 1_700_100_000_000,
    });
    await reserveOperation(storage, {
      ...PERIOD,
      operationId: 'operation_before_period_change',
      limit: 1,
    });
    await reserveOperation(storage, {
      periodStartMs: PERIOD.periodEndMs,
      periodEndMs: PERIOD.periodEndMs + 2_678_400_000,
      operationId: 'operation_after_period_change',
      limit: 1,
    });

    assert.deepEqual(await getTransactionRevocation(storage, transactionHash), {
      revoked: true,
      revokedAtMs: 1_700_100_000_000,
    });
  });

  it('clears only the matching transaction on a refund reversal', async () => {
    const storage = new MemoryLedgerStorage();
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    await setTransactionRevocation(storage, { transactionHash: first, revoked: true });
    await setTransactionRevocation(storage, { transactionHash: second, revoked: true });
    await setTransactionRevocation(storage, { transactionHash: first, revoked: false });

    assert.deepEqual(await getTransactionRevocation(storage, first), { revoked: false });
    assert.equal((await getTransactionRevocation(storage, second)).revoked, true);
  });

  it('ignores an older refund delivered after a refund reversal', async () => {
    const storage = new MemoryLedgerStorage();
    const transactionHash = 'a'.repeat(64);
    await setTransactionRevocation(storage, {
      transactionHash,
      revoked: false,
      revokedAtMs: 1_700_200_000_000,
    });
    await setTransactionRevocation(storage, {
      transactionHash,
      revoked: true,
      revokedAtMs: 1_700_100_000_000,
    });

    assert.deepEqual(await getTransactionRevocation(storage, transactionHash), { revoked: false });
  });

  it('cleans expired quota state without deleting revocation state', async () => {
    const storage = new MemoryLedgerStorage();
    const transactionHash = 'a'.repeat(64);
    await setTransactionRevocation(storage, { transactionHash, revoked: true });
    await reserveOperation(storage, {
      ...PERIOD,
      operationId: 'operation_before_cleanup',
    });

    assert.equal(await clearExpiredQuota(storage, PERIOD.periodEndMs), true);
    assert.deepEqual(await getTransactionRevocation(storage, transactionHash), {
      revoked: true,
      revokedAtMs: (await getTransactionRevocation(storage, transactionHash)).revokedAtMs,
    });
    const next = await reserveOperation(storage, {
      periodStartMs: PERIOD.periodEndMs,
      periodEndMs: PERIOD.periodEndMs + 2_678_400_000,
      operationId: 'operation_after_cleanup',
    });
    assert.equal(next.used, 1);
  });

  it('rejects missing, short, or unsafe operation ids', () => {
    assert.equal(isValidOperationId(null), false);
    assert.equal(isValidOperationId('short'), false);
    assert.equal(isValidOperationId('operation id with spaces'), false);
    assert.equal(isValidOperationId('01J00000000000000000000000'), true);
  });
});
