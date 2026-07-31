import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractDashboardToken, isDashboardAuthorized } from './dashboard';

describe('dashboard auth', () => {
  const env = { DASHBOARD_TOKEN: 'dashboard-secret-token-32chars!!' };

  it('accepts bearer', () => {
    const req = new Request('https://ai.example/dashboard', {
      headers: { authorization: `Bearer ${env.DASHBOARD_TOKEN}` },
    });
    assert.equal(isDashboardAuthorized(env, req), true);
  });

  it('rejects wrong token', () => {
    const req = new Request('https://ai.example/dashboard', {
      headers: { authorization: 'Bearer wrong-token-wrong-token' },
    });
    assert.equal(isDashboardAuthorized(env, req), false);
  });

  it('reads query token', () => {
    const req = new Request(`https://ai.example/dashboard?token=${env.DASHBOARD_TOKEN}`);
    assert.equal(extractDashboardToken(req), env.DASHBOARD_TOKEN);
  });

  it('disabled when secret short', () => {
    const req = new Request('https://ai.example/dashboard', {
      headers: { authorization: 'Bearer short' },
    });
    assert.equal(isDashboardAuthorized({ DASHBOARD_TOKEN: 'short' }, req), false);
  });
});
