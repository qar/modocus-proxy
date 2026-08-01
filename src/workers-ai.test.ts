import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeRoutingConfig } from './models';
import {
  type AiBinding,
  handleChatCompletions,
  MAX_CHAT_OUTPUT_TOKENS,
  MAX_CHAT_REQUEST_CHARS,
} from './workers-ai';

const ROUTING = normalizeRoutingConfig({
  slots: {
    default: '@cf/meta/llama-3.2-3b-instruct',
  },
});

function chatRequest(body: unknown): Request {
  return new Request('https://ai.modocus.app/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function recordingAi(): {
  ai: AiBinding;
  calls: Array<{ model: string; inputs: Record<string, unknown> }>;
} {
  const calls: Array<{ model: string; inputs: Record<string, unknown> }> = [];
  return {
    calls,
    ai: {
      run: async (model, inputs) => {
        calls.push({ model, inputs });
        return { response: 'ok' };
      },
    },
  };
}

describe('chat request cost bounds', () => {
  it('rejects requests over the 160,000-character limit before inference', async () => {
    const { ai, calls } = recordingAi();
    const response = await handleChatCompletions(ai, chatRequest({
      messages: [{ role: 'user', content: 'x'.repeat(MAX_CHAT_REQUEST_CHARS) }],
    }), ROUTING);

    assert.equal(response.status, 413);
    assert.equal(calls.length, 0);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'request_too_large');
  });

  it('clamps requested output to 4,096 tokens', async () => {
    const { ai, calls } = recordingAi();
    const response = await handleChatCompletions(ai, chatRequest({
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100_000,
    }), ROUTING);

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.inputs.max_tokens, MAX_CHAT_OUTPUT_TOKENS);
  });

  it('rejects valid JSON that is not an object', async () => {
    const { ai, calls } = recordingAi();
    const response = await handleChatCompletions(ai, chatRequest(null), ROUTING);

    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
});

describe('chat model selection', () => {
  it('does not let the client select an arbitrary upstream model', async () => {
    const { ai, calls } = recordingAi();
    const response = await handleChatCompletions(ai, chatRequest({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'openai/expensive-client-selected-model',
    }), ROUTING);

    assert.equal(response.status, 200);
    assert.equal(calls[0]?.model, '@cf/meta/llama-3.2-3b-instruct');
  });
});
