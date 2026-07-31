import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveUpstream } from './upstream';

describe('resolveUpstream', () => {
  it('routes @cf to workers-ai', () => {
    assert.deepEqual(resolveUpstream('@cf/openai/gpt-oss-120b'), {
      provider: 'workers-ai',
      model: '@cf/openai/gpt-oss-120b',
    });
  });

  it('routes OpenAI bare and openai/ slugs', () => {
    assert.deepEqual(resolveUpstream('gpt-4o-mini'), {
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    assert.deepEqual(resolveUpstream('openai/gpt-4o-mini'), {
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    assert.deepEqual(resolveUpstream('chatgpt-4o-mini'), {
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
  });

  it('routes org/model to openrouter', () => {
    assert.deepEqual(resolveUpstream('anthropic/claude-3.5-haiku'), {
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-haiku',
    });
    assert.deepEqual(resolveUpstream('openrouter/google/gemini-2.5-flash'), {
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
    });
  });
});
