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
