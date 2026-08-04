/**
 * Hosted transcription duration cap. Voice is billed per audio minute, so the
 * 400-op quota alone does not bound cost — the public promise is one hosted
 * take ≤ 90 s (monetization.md §5/§9). The client stops recording at 90 s;
 * this module is the server-side second check.
 */

export const MAX_HOSTED_AUDIO_SECONDS = 90;

/**
 * Small grace over the public 90 s so a client that stops the recorder at
 * exactly 90.0 s is never rejected for container/rounding overhead.
 */
const GRACE_SECONDS = 1.5;

/**
 * Byte backstop for audio whose duration cannot be parsed and whose declared
 * length is missing or dishonest. The app records AAC ≤ 128 kbps, so 90 s is
 * ~1.5 MB; anything past this is over the cap in every supported encoding.
 */
export const MAX_HOSTED_AUDIO_BYTES = 2_500_000;

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0)
  );
}

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function parseMvhd(bytes: Uint8Array, start: number, end: number): number | null {
  const version = bytes[start];
  // v0: ctime/mtime are u32 → timescale at +12, duration u32 at +16.
  // v1: ctime/mtime are u64 → timescale at +20, duration u64 at +24.
  const timescaleOffset = version === 1 ? start + 4 + 16 : start + 4 + 8;
  const durationOffset = timescaleOffset + 4;
  const durationEnd = version === 1 ? durationOffset + 8 : durationOffset + 4;
  if (durationEnd > end)
    return null;
  const timescale = u32(bytes, timescaleOffset);
  const duration = version === 1
    // Files under the cap never exceed 2^53 ticks; precision loss is fine.
    ? u32(bytes, durationOffset) * 0x100000000 + u32(bytes, durationOffset + 4)
    : u32(bytes, durationOffset);
  if (timescale <= 0 || duration < 0)
    return null;
  const seconds = duration / timescale;
  // Sanity bound — a nonsense mvhd must not override the byte backstop.
  return seconds >= 0 && seconds <= 86_400 ? seconds : null;
}

function walkBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  depth: number,
): number | null {
  let offset = start;
  while (offset + 8 <= end) {
    const size = u32(bytes, offset);
    const type = boxType(bytes, offset + 4);
    // size 1 (64-bit largesize) and size 0 (extends to EOF) never occur in
    // clips this small — treat them as unparseable rather than guessing.
    if (size < 8 || offset + size > end)
      return null;
    if (type === 'mvhd')
      return parseMvhd(bytes, offset + 8, offset + size);
    if (type === 'moov' && depth === 0) {
      const nested = walkBoxes(bytes, offset + 8, offset + size, 1);
      if (nested != null)
        return nested;
    }
    offset += size;
  }
  return null;
}

/**
 * Duration in seconds from an MP4/M4A movie header, or null when the payload
 * is not parseable ISO-BMFF (then the caller falls back to declared/byte checks).
 */
export function mp4DurationSeconds(bytes: Uint8Array): number | null {
  return walkBoxes(bytes, 0, bytes.length, 0);
}

export type AudioLimitResult
  = | { ok: true }
    | { ok: false; reason: 'duration' | 'bytes'; seconds?: number };

/**
 * Server-side cap for one hosted transcription request. `declaredSeconds` is
 * the client's `X-Modocus-Audio-Seconds` header (0 when absent); the parsed
 * container duration wins over it when available.
 */
export function checkHostedAudioLimit(
  bytes: Uint8Array,
  declaredSeconds: number,
): AudioLimitResult {
  if (bytes.length > MAX_HOSTED_AUDIO_BYTES)
    return { ok: false, reason: 'bytes' };
  const limit = MAX_HOSTED_AUDIO_SECONDS + GRACE_SECONDS;
  const parsed = mp4DurationSeconds(bytes);
  if (parsed != null && parsed > limit)
    return { ok: false, reason: 'duration', seconds: parsed };
  if (parsed == null && declaredSeconds > limit)
    return { ok: false, reason: 'duration', seconds: declaredSeconds };
  return { ok: true };
}
