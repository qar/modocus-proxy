/**
 * Auth policy unit tests (no real Apple JWS required).
 * Run: npx tsx --test src/auth.test.ts
 *  or: node --import tsx --test src/auth.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { authenticateBearer, isStaging } from './auth';

describe('isStaging', () => {
  it('defaults to production', () => {
    assert.equal(isStaging({}), false);
  });
  it('detects staging', () => {
    assert.equal(isStaging({ ENVIRONMENT: 'staging' }), true);
    assert.equal(isStaging({ ENVIRONMENT: 'STAGING' }), true);
  });
});

describe('authenticateBearer production', () => {
  const prod = {
    ENVIRONMENT: 'production',
    DEV_BYPASS_TOKEN: 'modocus-dev-bypass-should-be-ignored-here',
  };

  it('rejects missing bearer', async () => {
    const r = await authenticateBearer(prod, null);
    assert.equal(r.ok, false);
    if (!r.ok)
      assert.equal(r.message, 'missing_bearer');
  });

  it('rejects anonymous short bearer', async () => {
    const r = await authenticateBearer(prod, 'abcdefgh');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 401);
      assert.equal(r.message, 'jws_required');
    }
  });

  it('ignores DEV_BYPASS even when secret matches', async () => {
    const r = await authenticateBearer(prod, prod.DEV_BYPASS_TOKEN);
    assert.equal(r.ok, false);
    if (!r.ok)
      assert.equal(r.message, 'jws_required');
  });

  it('rejects malformed three-part non-cert JWS', async () => {
    const r = await authenticateBearer(prod, 'aaa.bbb.ccc');
    assert.equal(r.ok, false);
    if (!r.ok)
      assert.ok(r.status === 401 || r.status === 403);
  });
});

describe('authenticateBearer staging', () => {
  const bypass = 'modocus-dev-bypass-f99b79de4abb63d0';
  const staging = {
    ENVIRONMENT: 'staging',
    DEV_BYPASS_TOKEN: bypass,
  };

  it('accepts exact DEV_BYPASS', async () => {
    const r = await authenticateBearer(staging, bypass);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.kind, 'dev_bypass');
      assert.ok(r.subject.startsWith('bypass:'));
    }
  });

  it('rejects wrong bypass', async () => {
    const r = await authenticateBearer(staging, 'modocus-dev-bypass-wrongwrongwrong');
    assert.equal(r.ok, false);
  });

  it('rejects short bypass secret env (not configured safely)', async () => {
    const r = await authenticateBearer({
      ENVIRONMENT: 'staging',
      DEV_BYPASS_TOKEN: 'short',
    }, 'short');
    assert.equal(r.ok, false);
  });
});

describe('free teaser bearer', () => {
  const INSTALL = 'free.v1.7b7f1e3c-1234-4abc-9def-0123456789ab';

  it('authenticates a free bearer with a month-window period', async () => {
    const r = await authenticateBearer({
      ENVIRONMENT: 'production',
      SUBJECT_HASH_SALT: 'salt-that-is-long-enough',
    }, INSTALL);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.kind, 'free');
      assert.ok(r.subject.startsWith('free:'));
      const start = new Date(r.periodStartMs);
      const end = new Date(r.periodEndMs);
      assert.equal(start.getUTCDate(), 1);
      assert.equal(end.getUTCDate(), 1);
      assert.ok(r.periodEndMs > r.periodStartMs);
    }
  });

  it('rejects a free bearer in production without a subject salt', async () => {
    const r = await authenticateBearer({ ENVIRONMENT: 'production' }, INSTALL);
    assert.equal(r.ok, false);
    if (!r.ok)
      assert.equal(r.message, 'subject_hash_salt_missing');
  });

  it('accepts a free bearer in staging without a salt', async () => {
    const r = await authenticateBearer({ ENVIRONMENT: 'staging' }, INSTALL);
    assert.equal(r.ok, true);
  });

  it('rejects malformed free bearers', async () => {
    const r = await authenticateBearer({
      ENVIRONMENT: 'production',
      SUBJECT_HASH_SALT: 'salt-that-is-long-enough',
    }, 'free.v1.not-a-uuid');
    assert.equal(r.ok, false);
    if (!r.ok)
      assert.equal(r.status, 401);
  });

  it('derives different subjects for different install ids', async () => {
    const env = { ENVIRONMENT: 'staging' };
    const a = await authenticateBearer(env, INSTALL);
    const b = await authenticateBearer(env, 'free.v1.00000000-0000-4000-8000-000000000000');
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok)
      assert.notEqual(a.subject, b.subject);
  });
});
