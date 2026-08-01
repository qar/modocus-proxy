import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  handleAppStoreNotification,
  subscriptionNotificationAction,
  validateNotificationTransaction,
  type ParsedNotification,
} from './app-store-notifications';
import type { VerifiedAppleTransaction } from './apple-jws';

const transaction: VerifiedAppleTransaction = {
  originalTransactionId: '100000000000001',
  transactionId: '100000000000002',
  productId: 'app.modocus.ai.monthly',
  bundleId: 'app.modocus',
  purchaseDate: 1_700_000_000_000,
  expiresDate: 1_702_678_400_000,
  environment: 'Production',
  type: 'Auto-Renewable Subscription',
};

const refund: ParsedNotification = {
  notificationType: 'REFUND',
  data: {
    bundleId: 'app.modocus',
    environment: 'Production',
  },
};

describe('App Store subscription notification policy', () => {
  it('maps refund and revocation events without expiring cancellations early', () => {
    assert.equal(subscriptionNotificationAction('REFUND'), 'revoke');
    assert.equal(subscriptionNotificationAction('REVOKE'), 'revoke');
    assert.equal(subscriptionNotificationAction('REFUND_REVERSED'), 'restore');
    assert.equal(subscriptionNotificationAction('DID_CHANGE_RENEWAL_STATUS'), null);
    assert.equal(subscriptionNotificationAction('DID_FAIL_TO_RENEW'), null);
  });

  it('requires the outer notification and inner transaction to agree', () => {
    assert.doesNotThrow(() => validateNotificationTransaction(refund, transaction));
    assert.throws(() => validateNotificationTransaction({
      ...refund,
      data: { ...refund.data!, bundleId: 'com.example.other' },
    }, transaction), /bundle_mismatch/);
    assert.throws(() => validateNotificationTransaction({
      ...refund,
      data: { ...refund.data!, environment: 'Sandbox' },
    }, transaction), /environment_mismatch/);
  });

  it('rejects malformed public webhook requests before state access', async () => {
    const response = await handleAppStoreNotification(new Request('https://example.test/apple/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }), {});
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'signed_payload_missing' });
  });
});
