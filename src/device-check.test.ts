import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isDeviceCheckConfigured, isSameUtcMonth } from './device-check';

describe('device check helpers', () => {
  it('matches Apple YYYY-MM markers against the current UTC month', () => {
    const nov2026 = Date.UTC(2026, 10, 15);
    assert.equal(isSameUtcMonth('2026-11', nov2026), true);
    assert.equal(isSameUtcMonth('2026-10', nov2026), false);
    assert.equal(isSameUtcMonth(null, nov2026), false);
  });

  it('is configured only when all three credentials are present', () => {
    assert.equal(isDeviceCheckConfigured({}), false);
    assert.equal(isDeviceCheckConfigured({
      DEVICECHECK_KEY_P8: 'x',
      DEVICECHECK_KEY_ID: 'KEYID12345',
    }), false);
    assert.equal(isDeviceCheckConfigured({
      DEVICECHECK_KEY_P8: 'x',
      DEVICECHECK_KEY_ID: 'KEYID12345',
      APPLE_TEAM_ID: 'TEAM123456',
    }), true);
  });
});
