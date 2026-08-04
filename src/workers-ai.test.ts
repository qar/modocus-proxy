import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeRoutingConfig } from './models';
import { syntheticM4a } from './test-audio';
import {
  type AiBinding,
  handleChatCompletions,
  handleTranscriptions,
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

describe('transcription duration cap', () => {
  function sttRequest(bytes: Uint8Array, declaredSeconds: number): Request {
    return new Request('https://ai.modocus.app/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-modocus-audio-seconds': String(declaredSeconds),
      },
      body: JSON.stringify({
        input_audio: { data: Buffer.from(bytes).toString('base64'), format: 'm4a' },
      }),
    });
  }

  it('rejects a 92-second clip with audio_too_long before inference', async () => {
    const { ai, calls } = recordingAi();
    const response = await handleTranscriptions(ai, sttRequest(syntheticM4a(92), 92), ROUTING);

    assert.equal(response.status, 413);
    assert.equal(calls.length, 0);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, 'audio_too_long');
  });

  it('lets a 90-second clip through to inference', async () => {
    const { ai, calls } = recordingAi();
    const response = await handleTranscriptions(ai, sttRequest(syntheticM4a(90), 90), ROUTING);

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
  });
});
