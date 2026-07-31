import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clearModelConfigCache,
  DEFAULT_CHAT_MODEL,
  DEFAULT_SLOT_MODELS,
  DEFAULT_STT_MODEL,
  FAST_CHAT_MODEL,
  modelForSlot,
  normalizeRoutingConfig,
  normalizeScene,
  resolveChatModel,
  resolveChatSlot,
  resolveSttModel,
  STRONG_CHAT_MODEL,
  validateSlotPatch,
} from './models';

describe('defaults', () => {
  it('ships gpt-oss-120b as default for all chat slots', () => {
    assert.equal(STRONG_CHAT_MODEL, '@cf/openai/gpt-oss-120b');
    assert.equal(DEFAULT_CHAT_MODEL, STRONG_CHAT_MODEL);
    assert.equal(FAST_CHAT_MODEL, STRONG_CHAT_MODEL);
    for (const slot of ['default', 'parse', 'plan', 'estimate', 'chat', 'insight', 'strong'] as const) {
      assert.equal(DEFAULT_SLOT_MODELS[slot], '@cf/openai/gpt-oss-120b');
    }
  });
});

describe('normalizeScene', () => {
  it('maps aliases', () => {
    assert.equal(normalizeScene('parse'), 'parse');
    assert.equal(normalizeScene('quickAdd'), 'parse');
    assert.equal(normalizeScene('X-Modocus'), null);
    assert.equal(normalizeScene('insight'), 'insight');
    assert.equal(normalizeScene('voice'), 'stt');
  });
});

describe('resolveChatSlot', () => {
  it('prefers explicit scene', () => {
    assert.equal(resolveChatSlot({ scene: 'plan', requestedModel: 'openai/gpt-4o' }), 'plan');
  });

  it('maps client slugs when no scene', () => {
    assert.equal(resolveChatSlot({ requestedModel: 'openai/gpt-4.1-nano' }), 'parse');
    assert.equal(resolveChatSlot({ requestedModel: 'openai/gpt-4o-mini' }), 'chat');
    assert.equal(resolveChatSlot({ requestedModel: 'openai/gpt-4o' }), 'strong');
  });

  it('uses shape heuristics', () => {
    assert.equal(resolveChatSlot({ wantsJson: true }), 'parse');
    assert.equal(resolveChatSlot({ hasTools: true }), 'chat');
    assert.equal(resolveChatSlot({}), 'default');
  });
});

describe('resolveChatModel with config', () => {
  const cfg = normalizeRoutingConfig({
    slots: {
      parse: '@cf/meta/llama-3.2-3b-instruct',
      chat: '@cf/openai/gpt-oss-20b',
      strong: '@cf/openai/gpt-oss-120b',
      default: '@cf/openai/gpt-oss-120b',
    },
  });

  it('routes scene to configured model', () => {
    assert.equal(
      resolveChatModel('openai/gpt-4o-mini', cfg, { scene: 'parse' }),
      '@cf/meta/llama-3.2-3b-instruct',
    );
    assert.equal(
      resolveChatModel('openai/gpt-4o-mini', cfg, { scene: 'chat' }),
      '@cf/openai/gpt-oss-20b',
    );
  });

  it('routes slug to slot then config', () => {
    assert.equal(
      resolveChatModel('openai/gpt-4.1-nano', cfg),
      '@cf/meta/llama-3.2-3b-instruct',
    );
    assert.equal(
      resolveChatModel('openai/gpt-4o', cfg),
      '@cf/openai/gpt-oss-120b',
    );
  });

  it('defaults empty to default slot', () => {
    assert.equal(resolveChatModel(undefined, cfg), '@cf/openai/gpt-oss-120b');
    assert.equal(resolveChatModel('', cfg), DEFAULT_CHAT_MODEL);
  });

  it('pass-through unknown @cf without scene', () => {
    assert.equal(
      resolveChatModel('@cf/meta/llama-3.2-1b-instruct-custom', cfg),
      '@cf/meta/llama-3.2-1b-instruct-custom',
    );
  });
});

describe('resolveSttModel', () => {
  it('maps whisper-1 to stt slot', () => {
    assert.equal(resolveSttModel('openai/whisper-1'), DEFAULT_STT_MODEL);
  });

  it('honors config stt slot', () => {
    const cfg = normalizeRoutingConfig({
      slots: { stt: '@cf/openai/whisper' },
    });
    assert.equal(resolveSttModel('whisper-1', cfg), '@cf/openai/whisper');
  });
});

describe('validateSlotPatch', () => {
  it('rejects unknown slot and unsafe model id', () => {
    assert.equal(validateSlotPatch({ nope: '@cf/openai/gpt-oss-120b' })?.includes('unknown'), true);
    assert.equal(
      validateSlotPatch({ parse: 'bad model with spaces' })?.includes('invalid'),
      true,
    );
  });

  it('accepts catalog and third-party ids', () => {
    assert.equal(validateSlotPatch({ parse: '@cf/openai/gpt-oss-20b', stt: '@cf/openai/whisper' }), null);
    assert.equal(validateSlotPatch({ chat: 'gpt-4o-mini', parse: 'openai/gpt-4o-mini' }), null);
    assert.equal(validateSlotPatch({ strong: 'anthropic/claude-3.5-haiku' }), null);
    assert.equal(validateSlotPatch({ chat: 'chatgpt-4o-mini' }), null);
  });
});

describe('modelForSlot', () => {
  it('falls back to defaults', () => {
    clearModelConfigCache();
    const cfg = normalizeRoutingConfig({ slots: {} });
    assert.equal(modelForSlot(cfg, 'chat'), DEFAULT_SLOT_MODELS.chat);
  });
});
