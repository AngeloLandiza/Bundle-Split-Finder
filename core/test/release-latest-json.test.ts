// latest.json and the signature check the release workflow makes before it publishes. The fixtures in fixtures/updater/
// were made with a throwaway key by @tauri-apps/cli 2.12.6 (`tauri signer generate --ci`, then `tauri signer sign
// --app-version 0.2.0`); its private key was never kept. Only its public key, the file and the signature are here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { decodePublicKey, decodeSignature, signedVersion, verifyUpdaterSignature } from '../../scripts/updater-signature';
import { ASSETS, assetUrl, buildLatestJson, LEGACY_DOWNLOAD_URL } from '../src/release/latestJson';
import { safeDownloadLink } from '../src/release/note';
import { isMinisignPublicKey, pubkeyOf, setPubkey } from '../src/release/pubkey';

const dir = join(import.meta.dirname, '..', '..', 'fixtures', 'updater');
const pubkey = readFileSync(join(dir, 'test.key.pub'), 'utf8').trim();
const signature = readFileSync(join(dir, 'artifact.bin.sig'), 'utf8').trim();
const data = readFileSync(join(dir, 'artifact.bin'));

/** The signature with one of its base64 lines replaced. */
function withLine(index: number, line: string): string {
  const parts = Buffer.from(signature, 'base64').toString('utf8').split('\n');
  parts[index] = line;
  return Buffer.from(parts.join('\n'), 'utf8').toString('base64');
}

describe('the updater signature, checked as the app checks it', () => {
  it('reads the formats tauri signer writes', () => {
    expect(decodePublicKey(pubkey)?.keyId).toBe('288a9723e0f4dd5e');
    const sig = decodeSignature(signature)!;
    expect(sig.prehashed).toBe(true);
    expect(sig.keyId).toBe('288a9723e0f4dd5e');
    expect(signedVersion(sig.trusted)).toBe('0.2.0');
    expect(isMinisignPublicKey(pubkey)).toBe(true);
  });

  it('accepts the file, the key and the version it was signed for', () => {
    expect(verifyUpdaterSignature({ pubkey, signature, data, version: '0.2.0' })).toEqual({ ok: true });
  });

  it('refuses a changed file, another version, another key, and a changed trusted comment', () => {
    const changed = Buffer.from(data);
    changed[0] = changed[0]! ^ 1;
    expect(verifyUpdaterSignature({ pubkey, signature, data: changed, version: '0.2.0' })).toMatchObject({ ok: false, why: 'the signature does not match the file' });
    expect(verifyUpdaterSignature({ pubkey, signature, data, version: '0.3.0' })).toMatchObject({ ok: false, why: 'it was signed for version 0.2.0, not 0.3.0' });
    // Another key: the same comment, another key id and key.
    const raw = Buffer.concat([Buffer.from('Ed'), Buffer.alloc(8, 1), Buffer.alloc(32, 2)]).toString('base64');
    const other = Buffer.from(`untrusted comment: minisign public key: 0101010101010101\n${raw}\n`).toString('base64');
    expect(verifyUpdaterSignature({ pubkey: other, signature, data, version: '0.2.0' })).toMatchObject({ ok: false, why: "it was signed with key 288A9723E0F4DD5E, not the app's key 0101010101010101" });
    // Someone edits the version in the trusted comment: its own signature no longer matches.
    const trusted = decodeSignature(signature)!.trusted.replace('version:0.2.0', 'version:9.9.9');
    expect(verifyUpdaterSignature({ pubkey, signature: withLine(2, `trusted comment: ${trusted}`), data, version: '9.9.9' })).toMatchObject({ ok: false, why: 'the trusted comment is not signed' });
    expect(verifyUpdaterSignature({ pubkey, signature: 'bm90IGEgc2lnbmF0dXJl', data, version: '0.2.0' })).toMatchObject({ ok: false });
    expect(verifyUpdaterSignature({ pubkey: 'eA==', signature, data, version: '0.2.0' })).toMatchObject({ ok: false });
  });
});

describe('latest.json', () => {
  const input = { version: '0.2.0', notes: ['Fixes the scan button.', 'Reads prices faster.'], pubDate: '2026-11-26T10:00:00.000Z', signatures: { 'darwin-aarch64': signature, 'windows-x86_64': signature } };

  it('is Tauri static format: version, notes, pub_date, and per platform the tag’s file and the .sig content', () => {
    const r = buildLatestJson(input);
    expect(r).toEqual({
      ok: true,
      json: {
        version: '0.2.0',
        notes: 'Fixes the scan button.\nReads prices faster.',
        pub_date: '2026-11-26T10:00:00.000Z',
        platforms: {
          'darwin-aarch64': { signature, url: 'https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.2.0/Split-Finder-Mac-Apple-silicon.app.tar.gz' },
          'windows-x86_64': { signature, url: 'https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v0.2.0/Split-Finder-Windows-x64-setup.exe' },
        },
      },
    });
  });

  it('refuses a missing platform, a signature that is a path or link, a bad version or notes', () => {
    expect(buildLatestJson({ ...input, signatures: { ...input.signatures, 'windows-x86_64': '' } })).toMatchObject({ ok: false, problem: 'No signature for windows-x86_64.' });
    expect(buildLatestJson({ ...input, signatures: { ...input.signatures, 'darwin-aarch64': 'https://example.com/x.sig' } })).toMatchObject({ ok: false });
    expect(buildLatestJson({ ...input, version: 'v0.2.0' })).toMatchObject({ ok: false });
    expect(buildLatestJson({ ...input, notes: [] })).toMatchObject({ ok: false });
    expect(buildLatestJson({ ...input, notes: ['two\nlines'] })).toMatchObject({ ok: false });
    expect(buildLatestJson({ ...input, pubDate: 'yesterday' })).toMatchObject({ ok: false });
  });

  it('keeps the file names the README links to, and the 0.1.0 installs get a link the app allows', () => {
    expect(ASSETS.windowsInstaller).toBe('Split-Finder-Windows-x64-setup.exe');
    expect(ASSETS.macDmg).toBe('Split-Finder-Mac-Apple-silicon.dmg');
    const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8');
    expect(readme).toContain(`releases/latest/download/${ASSETS.windowsInstaller}`);
    expect(readme).toContain(`releases/latest/download/${ASSETS.macDmg}`);
    expect(safeDownloadLink(LEGACY_DOWNLOAD_URL)).toBe(LEGACY_DOWNLOAD_URL);
    expect(assetUrl('v1.0.0', 'x')).toBe('https://github.com/AngeloLandiza/Bundle-Split-Finder/releases/download/v1.0.0/x');
  });
});

describe('the public key in tauri.conf.json', () => {
  const conf = readFileSync(join(import.meta.dirname, '..', '..', 'src-tauri', 'tauri.conf.json'), 'utf8');

  it('is written into plugins.updater.pubkey and nowhere else, changing only that line', () => {
    const r = setPubkey(conf, `${pubkey}\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(pubkeyOf(r.text)).toBe(pubkey);
    const before = conf.split('\n');
    const after = r.text.split('\n');
    expect(after).toHaveLength(before.length);
    expect(after.filter((l, i) => l !== before[i])).toHaveLength(1);
    // Written again with the same key: no change.
    expect(setPubkey(r.text, pubkey)).toEqual({ ok: true, text: r.text });
  });

  it('refuses what is not a minisign public key', () => {
    for (const bad of ['', 'not base64!', Buffer.from('hello').toString('base64'), readFileSync(join(dir, 'artifact.bin.sig'), 'utf8')]) {
      expect(setPubkey(conf, bad).ok).toBe(false);
    }
  });
});
