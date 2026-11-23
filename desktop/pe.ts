// The one PE (Windows .exe) edit the sidecar build needs: dropping node.exe's Authenticode signature
// before the SEA blob goes in. Injecting into a signed file leaves a signature that no longer matches,
// which Windows reports as a tampered file; an unsigned file is only an unknown one. This is what
// `signtool remove /s` does (Node's SEA guide, Windows), without needing signtool on a Mac.
//
// PE layout: the DOS header names the PE header at 0x3C; the optional header follows the 20-byte COFF
// header; its data directory 4 (the certificate table) holds a file offset and a size, and the table
// itself sits at the end of the file.

const PE32 = 0x10b;
const PE32_PLUS = 0x20b;

export type StripResult = { bytes: Buffer; stripped: boolean };

/** The file without its certificate table, and the directory entry and checksum zeroed. Throws on a file that is not PE. */
export function stripAuthenticode(input: Buffer): StripResult {
  if (input.length < 0x40 || input.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (no MZ header)');
  const pe = input.readUInt32LE(0x3c);
  if (pe + 24 > input.length || input.readUInt32LE(pe) !== 0x00004550) throw new Error('not a PE file (no PE signature)');
  const opt = pe + 24;
  const magic = input.readUInt16LE(opt);
  if (magic !== PE32 && magic !== PE32_PLUS) throw new Error(`unknown optional header magic 0x${magic.toString(16)}`);
  const dirs = opt + (magic === PE32_PLUS ? 112 : 96);
  const count = input.readUInt32LE(dirs - 4);
  if (count < 5) return { bytes: input, stripped: false };
  const entry = dirs + 4 * 8;
  const offset = input.readUInt32LE(entry);
  const size = input.readUInt32LE(entry + 4);
  if (offset === 0 || size === 0) return { bytes: input, stripped: false };
  if (offset + size !== input.length) {
    throw new Error('the certificate table is not at the end of the file; refusing to cut it');
  }
  const out = Buffer.from(input.subarray(0, offset));
  out.writeUInt32LE(0, entry);
  out.writeUInt32LE(0, entry + 4);
  // CheckSum (optional header + 64): only drivers and boot files are checked; zero means "not set".
  out.writeUInt32LE(0, opt + 64);
  return { bytes: out, stripped: true };
}
