/** Test-only builders for minimal ISO-BMFF (m4a) payloads. */

function fourCc(type: string): number[] {
  return [...type].map(c => c.charCodeAt(0));
}

function u32Bytes(value: number): number[] {
  return [(value >>> 24) & 0xFF, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF];
}

function box(type: string, payload: number[]): number[] {
  return [...u32Bytes(8 + payload.length), ...fourCc(type), ...payload];
}

/** Minimal ftyp + moov>mvhd (version 0) file with the given duration. */
export function syntheticM4a(durationSeconds: number, timescale = 1000): Uint8Array {
  const mvhdPayload = [
    0, 0, 0, 0, // version 0 + flags
    ...u32Bytes(0), // creation time
    ...u32Bytes(0), // modification time
    ...u32Bytes(timescale),
    ...u32Bytes(Math.round(durationSeconds * timescale)),
    ...Array.from({ length: 80 }, () => 0), // rate/volume/matrix/etc.
  ];
  return new Uint8Array([
    ...box('ftyp', [...fourCc('M4A '), ...u32Bytes(0)]),
    ...box('moov', box('mvhd', mvhdPayload)),
    ...box('mdat', Array.from({ length: 64 }, () => 0)),
  ]);
}
