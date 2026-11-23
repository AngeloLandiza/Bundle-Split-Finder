import { describe, expect, it } from 'vitest';

import { stripAuthenticode } from './pe';

/** A PE32+ skeleton: DOS header, PE header at 0x80, 16 data directories, a body, then a certificate table. */
function pe(cert: Buffer | null, opts: { magic?: number } = {}): Buffer {
  const peAt = 0x80;
  const opt = peAt + 24;
  const dirs = opt + 112;
  const body = 0x200;
  const buf = Buffer.alloc(body + 0x100 + (cert?.length ?? 0));
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(peAt, 0x3c);
  buf.writeUInt32LE(0x00004550, peAt);
  buf.writeUInt16LE(opts.magic ?? 0x20b, opt);
  buf.writeUInt32LE(0xdeadbeef, opt + 64); // CheckSum
  buf.writeUInt32LE(16, dirs - 4);
  buf.fill(0x41, body, body + 0x100);
  if (cert) {
    const at = body + 0x100;
    cert.copy(buf, at);
    buf.writeUInt32LE(at, dirs + 32);
    buf.writeUInt32LE(cert.length, dirs + 36);
  }
  return buf;
}

describe('stripAuthenticode', () => {
  it('cuts the certificate table off the end and zeroes its entry and the checksum', () => {
    const signed = pe(Buffer.alloc(64, 0x99));
    const { bytes, stripped } = stripAuthenticode(signed);
    expect(stripped).toBe(true);
    expect(bytes.length).toBe(signed.length - 64);
    expect(bytes.readUInt32LE(0x80 + 24 + 112 + 32)).toBe(0);
    expect(bytes.readUInt32LE(0x80 + 24 + 112 + 36)).toBe(0);
    expect(bytes.readUInt32LE(0x80 + 24 + 64)).toBe(0);
    expect(bytes.subarray(0x200, 0x300).every((b) => b === 0x41)).toBe(true);
  });

  it('leaves an unsigned file as it is', () => {
    const plain = pe(null);
    const { bytes, stripped } = stripAuthenticode(plain);
    expect(stripped).toBe(false);
    expect(bytes.equals(plain)).toBe(true);
  });

  it('refuses a file that is not PE, and a table that is not at the end', () => {
    expect(() => stripAuthenticode(Buffer.alloc(0x100))).toThrow(/MZ/);
    const signed = pe(Buffer.alloc(64, 0x99));
    const longer = Buffer.concat([signed, Buffer.alloc(8)]);
    expect(() => stripAuthenticode(longer)).toThrow(/not at the end/);
  });
});
