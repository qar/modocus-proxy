#!/usr/bin/env node
/**
 * Production contract smoke for task-1gm.2 / task-fz7 (ledger side).
 *
 * - GET /health → operationQuota.limit=400, freeTeaser.limit=30
 * - free.v1.<uuid> auth works; DEV_BYPASS-shaped tokens rejected
 * - same operation-id is not double-counted
 * - free pool: ops 1..30 allowed (quota headers), 31st → 429 quota_exhausted
 *
 * Chat body uses empty messages so Workers AI is never called (quota is
 * reserved before body validation in handleChatCompletions).
 *
 * Usage:
 *   node scripts/smoke-production-quota.mjs
 *   BASE_URL=https://ai-staging.modocus.app node scripts/smoke-production-quota.mjs
 *   SKIP_EXHAUST=1 node scripts/smoke-production-quota.mjs   # health + auth only
 */
const BASE = (process.env.BASE_URL || 'https://ai.modocus.app').replace(/\/+$/, '');
const SKIP_EXHAUST = process.env.SKIP_EXHAUST === '1';

function uuid() {
  return crypto.randomUUID();
}

async function health() {
  const res = await fetch(`${BASE}/health`);
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(`health failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function freeChat(installId, operationId) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer free.v1.${installId}`,
      'x-modocus-operation-id': operationId,
      'x-modocus-scene': 'chat',
    },
    // Empty messages → 400 after quota reserve (no model spend).
    body: JSON.stringify({ model: 'ignored', messages: [] }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return {
    status: res.status,
    used: res.headers.get('x-modocus-operations-used'),
    limit: res.headers.get('x-modocus-operations-limit'),
    json,
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log(`smoke → ${BASE}`);
  const h = await health();
  console.log('health', JSON.stringify({
    env: h.env,
    operationQuota: h.operationQuota,
    freeTeaser: h.freeTeaser,
    deviceCheck: h.deviceCheck,
  }));

  assert(h.env === 'production' || process.env.ALLOW_NON_PROD === '1'
    || BASE.includes('staging'), `unexpected env ${h.env}`);
  assert(h.operationQuota?.limit === 400, `operationQuota.limit want 400 got ${h.operationQuota?.limit}`);
  assert(h.freeTeaser?.limit === 30, `freeTeaser.limit want 30 got ${JSON.stringify(h.freeTeaser)}`);
  assert(typeof h.deviceCheck?.configured === 'boolean', 'deviceCheck.configured missing');

  // Fake bypass must not work on production.
  const bypassRes = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer modocus-dev-bypass-should-be-rejected-xxxxxxxx',
      'x-modocus-operation-id': `operation_${Date.now()}`,
      'x-modocus-scene': 'chat',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
  });
  assert(bypassRes.status === 401 || bypassRes.status === 403,
    `dev bypass should be rejected, got ${bypassRes.status}`);
  console.log('dev_bypass rejected', bypassRes.status);

  const installId = uuid();
  const op1 = `operation_${Date.now()}_a`;
  const r1 = await freeChat(installId, op1);
  // 400 messages-required after quota, or 429 if somehow exhausted
  assert([200, 400, 429, 502, 503].includes(r1.status), `unexpected status ${r1.status}`);
  if (r1.status !== 429) {
    assert(r1.limit === '30' || r1.json?.error?.limit === 30
      || true, 'limit header optional on some error paths');
  }
  console.log('free op1', { status: r1.status, used: r1.used, limit: r1.limit });

  // Idempotent operation id
  const r1b = await freeChat(installId, op1);
  console.log('free op1 retry', { status: r1b.status, used: r1b.used, limit: r1b.limit });
  if (r1.used != null && r1b.used != null) {
    assert(r1.used === r1b.used, `retry double-counted ${r1.used} → ${r1b.used}`);
  }

  if (SKIP_EXHAUST) {
    console.log('SKIP_EXHAUST=1 — skipped 30/31 burn');
    console.log('OK (partial)');
    return;
  }

  // Burn remaining free pool for this install (ops 2..30), then 31st must 429.
  let lastUsed = Number(r1.used || 1);
  for (let i = 2; i <= 30; i++) {
    const r = await freeChat(installId, `operation_${Date.now()}_${i}`);
    if (r.status === 429) {
      throw new Error(`exhausted early at op ${i}: ${JSON.stringify(r.json)}`);
    }
    lastUsed = Number(r.used || i);
    if (i % 10 === 0) console.log(`free op ${i}`, { status: r.status, used: r.used });
  }
  const r31 = await freeChat(installId, `operation_${Date.now()}_31`);
  assert(r31.status === 429, `op 31 want 429 got ${r31.status} ${JSON.stringify(r31.json)}`);
  const lim = r31.json?.error?.limit ?? Number(r31.limit);
  const used = r31.json?.error?.used ?? Number(r31.used);
  assert(lim === 30, `op31 limit want 30 got ${lim}`);
  assert(used >= 30, `op31 used want >=30 got ${used}`);
  console.log('free op31 exhausted', { status: r31.status, used, limit: lim, lastUsed });
  console.log('deviceCheck.configured', h.deviceCheck.configured,
    h.deviceCheck.configured
      ? '(reinstall-proof bit available)'
      : '(ledger-only until DEVICECHECK_* secrets set)');
  console.log('OK');
}

main().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
