import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkHostedAudioLimit,
  MAX_HOSTED_AUDIO_BYTES,
  mp4DurationSeconds,
} from './audio-limits';
import { syntheticM4a } from './test-audio';

describe('hosted audio duration cap', () => {
  it('parses the mvhd duration from an m4a container', () => {
    assert.equal(mp4DurationSeconds(syntheticM4a(88)), 88);
    assert.equal(mp4DurationSeconds(syntheticM4a(92)), 92);
  });

  it('returns null for payloads that are not ISO-BMFF', () => {
    assert.equal(mp4DurationSeconds(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), null);
    assert.equal(mp4DurationSeconds(new Uint8Array(0)), null);
  });

  it('accepts a 90-second take and rejects a 92-second one', () => {
    assert.deepEqual(checkHostedAudioLimit(syntheticM4a(90), 90), { ok: true });
    const rejected = checkHostedAudioLimit(syntheticM4a(92), 92);
    assert.equal(rejected.ok, false);
  });

  it('parsed container duration overrides an understated declared header', () => {
    const rejected = checkHostedAudioLimit(syntheticM4a(120), 30);
    assert.deepEqual(rejected, { ok: false, reason: 'duration', seconds: 120 });
  });

  it('falls back to the declared header when duration is unparseable', () => {
    const opaque = new Uint8Array(1024).fill(7);
    assert.deepEqual(checkHostedAudioLimit(opaque, 60), { ok: true });
    assert.equal(checkHostedAudioLimit(opaque, 120).ok, false);
  });

  it('rejects oversized payloads regardless of declared duration', () => {
    const oversized = new Uint8Array(MAX_HOSTED_AUDIO_BYTES + 1);
    assert.deepEqual(checkHostedAudioLimit(oversized, 0), { ok: false, reason: 'bytes' });
  });
});
