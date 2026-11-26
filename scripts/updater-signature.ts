// Checks a Tauri updater signature (minisign) against a public key, as the app's updater does before it installs anything
// (tauri-plugin-updater's verify_signature). The release workflow runs it on every .sig before publishing, so a release
// signed with a key the installed apps do not trust, or for another version, is never published. Node only (node:crypto).
//
// Formats, as `tauri signer` writes them (checked on files made by @tauri-apps/cli 2.12.6, fixtures/updater/):
//   public key (plugins.updater.pubkey, the .pub file): base64 of
//     "untrusted comment: minisign public key: <ID>\n" + base64("Ed" + key id (8 bytes) + Ed25519 key (32 bytes)) + "\n"
//   signature (the .sig file, latest.json's `signature`): base64 of
//     "untrusted comment: …\n" + base64(alg (2) + key id (8) + signature (64)) + "\n"
//     "trusted comment: timestamp:…\tfile:…\tversion:<x.y.z>\n" + base64(global signature (64)) + "\n"
//   alg "ED": the signature is over BLAKE2b-512 of the file; "Ed": over the file itself. The global signature is over the
//   signature bytes followed by the trusted comment, so the version in it is covered.
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const lines = (b64: string): string[] => Buffer.from(b64.trim(), 'base64').toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));

export interface PublicKey {
  keyId: string;
  key: KeyObject;
}

/** The public key as plugins.updater.pubkey holds it, or null when it is not one. */
export function decodePublicKey(b64: string): PublicKey | null {
  const [comment, body] = lines(b64);
  if (!comment?.startsWith('untrusted comment:') || !body) return null;
  const raw = Buffer.from(body, 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') return null;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]), format: 'der', type: 'spki' });
    return { keyId: raw.subarray(2, 10).toString('hex'), key };
  } catch {
    return null;
  }
}

export interface Signature {
  prehashed: boolean;
  keyId: string;
  signature: Buffer;
  trusted: string;
  global: Buffer;
}

/** A .sig file's content (or latest.json's `signature`), or null when it is not one. */
export function decodeSignature(b64: string): Signature | null {
  const [comment, body, trustedLine, globalLine] = lines(b64);
  if (!comment?.startsWith('untrusted comment:') || !body || !trustedLine?.startsWith('trusted comment: ') || !globalLine) return null;
  const raw = Buffer.from(body, 'base64');
  const alg = raw.subarray(0, 2).toString('latin1');
  const global = Buffer.from(globalLine, 'base64');
  if (raw.length !== 74 || (alg !== 'ED' && alg !== 'Ed') || global.length !== 64) return null;
  return { prehashed: alg === 'ED', keyId: raw.subarray(2, 10).toString('hex'), signature: raw.subarray(10), trusted: trustedLine.slice('trusted comment: '.length), global };
}

/** The version a signature was made for ("version:" in its trusted comment), or null (signed by a CLI before 2.12). */
export const signedVersion = (trusted: string): string | null => trusted.split('\t').find((f) => f.startsWith('version:'))?.slice('version:'.length) ?? null;

/**
 * Whether `data` carries a valid signature by `pubkey`, made for `version`. The same checks the app makes with
 * requireSignedVersion on: the key id, the signature, the trusted comment's signature, and the version in it.
 */
export function verifyUpdaterSignature(o: { pubkey: string; signature: string; data: Buffer; version: string }): { ok: true } | { ok: false; why: string } {
  const pk = decodePublicKey(o.pubkey);
  if (!pk) return { ok: false, why: 'the public key is not a minisign public key' };
  const sig = decodeSignature(o.signature);
  if (!sig) return { ok: false, why: 'the signature is not a minisign signature' };
  if (sig.keyId !== pk.keyId) return { ok: false, why: `it was signed with key ${sig.keyId.toUpperCase()}, not the app's key ${pk.keyId.toUpperCase()}` };
  const message = sig.prehashed ? createHash('blake2b512').update(o.data).digest() : o.data;
  if (!verify(null, message, pk.key, sig.signature)) return { ok: false, why: 'the signature does not match the file' };
  if (!verify(null, Buffer.concat([sig.signature, Buffer.from(sig.trusted, 'utf8')]), pk.key, sig.global)) return { ok: false, why: 'the trusted comment is not signed' };
  const v = signedVersion(sig.trusted);
  if (v === null) return { ok: false, why: 'the signature names no version (made by a Tauri CLI older than 2.12)' };
  if (v !== o.version) return { ok: false, why: `it was signed for version ${v}, not ${o.version}` };
  return { ok: true };
}
