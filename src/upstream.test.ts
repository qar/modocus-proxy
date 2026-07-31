import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeGatewayModelId, resolveUpstream } from './upstream';

describe('normalizeGatewayModelId', () => {
  it('prefixes bare openai family ids', () => {
    assert.equal(normalizeGatewayModelId('gpt-4o-mini'), 'openai/gpt-4o-mini');
    assert.equal(normalizeGatewayModelId('chatgpt-4o-mini'), 'openai/gpt-4o-mini');
  });

  it('leaves provider and @cf ids', () => {
    assert.equal(normalizeGatewayModelId('anthropic/claude-sonnet-4'), 'anthropic/claude-sonnet-4');
    assert.equal(normalizeGatewayModelId('@cf/openai/gpt-oss-120b'), '@cf/openai/gpt-oss-120b');
  });
});

describe('resolveUpstream', () => {
  it('routes @cf to workers-ai', () => {
    assert.deepEqual(resolveUpstream('@cf/openai/gpt-oss-120b'), {
      provider: 'workers-ai',
      model: '@cf/openai/gpt-oss-120b',
    });
  });

  it('routes OpenAI / Claude / Gemini to ai-gateway', () => {
    assert.deepEqual(resolveUpstream('gpt-4o-mini'), {
      provider: 'ai-gateway',
      model: 'openai/gpt-4o-mini',
    });
    assert.deepEqual(resolveUpstream('openai/gpt-4o'), {
      provider: 'ai-gateway',
      model: 'openai/gpt-4o',
    });
    assert.deepEqual(resolveUpstream('anthropic/claude-3.5-haiku'), {
      provider: 'ai-gateway',
      model: 'anthropic/claude-3.5-haiku',
    });
    assert.deepEqual(resolveUpstream('google/gemini-2.5-flash'), {
      provider: 'ai-gateway',
      model: 'google/gemini-2.5-flash',
    });
  });

  it('uses legacy OpenAI HTTP only when allowed and no gateway', () => {
    assert.deepEqual(
      resolveUpstream('gpt-4o-mini', {
        ALLOW_LEGACY_HTTP_UPSTREAM: 'true',
        OPENAI_API_KEY: 'sk-test',
      }),
      { provider: 'openai', model: 'gpt-4o-mini' },
    );
    // Gateway id present → still prefer gateway
    assert.deepEqual(
      resolveUpstream('gpt-4o-mini', {
        ALLOW_LEGACY_HTTP_UPSTREAM: 'true',
        AI_GATEWAY_ID: 'modocus',
        OPENAI_API_KEY: 'sk-test',
      }),
      { provider: 'ai-gateway', model: 'openai/gpt-4o-mini' },
    );
  });
});
