import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { runTool } from '../scripts/spawn-tool';

/** The entries of a zip, read in Node (a Windows runner has no unzip): name to text, from the central directory. */
function readZip(file: string): Map<string, string> {
  const buf = readFileSync(file);
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
  }
  return out;
}

// Runs the real `npm run package` and reads the zip it wrote. Spends no searches.
describe('npm run package', () => {
  it('writes one zip with the version in its name, holding only the built extension', () => {
    const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
    runTool('npm', ['run', 'package'], {
      env: { ...process.env, SPLIT_FINDER_E2E: '', SPLIT_FINDER_DEBUG: '', SPLIT_FINDER_PROD_CHECK: '', SPLIT_FINDER_PACKAGE: '' },
      stdio: 'ignore',
    });
    const name = `bundle-split-finder-${version}-chrome.zip`;
    const zip = join('output', name);
    expect(existsSync(zip)).toBe(true);

    const entries = readZip(zip);
    const list = [...entries.keys()];
    expect(list).toContain('manifest.json');
    expect(list).toContain('background.js');
    expect(list).toContain('sidepanel.html');
    expect(list).toContain('options.html');
    expect(list).toContain('content-scripts/homedepot.js');

    // Only the extension's own kinds of file; no dotfiles, no maps, nothing from the repo or the end-to-end build.
    for (const f of list) {
      expect(f, f).toMatch(/\.(js|css|html|json|woff2|txt)$/);
      expect(f, f).not.toMatch(/(^|\/)\./);
      expect(f, f).not.toMatch(/\.map$/);
      expect(f, f).not.toMatch(/env|e2e|fixtures|node_modules|\.output/i);
    }

    // A real key from a local .env, if one exists, must not be in any file. Never printed.
    const envKey = existsSync('.env')
      ? /^SERPAPI_(?:API_)?KEY=(.+)$/m.exec(readFileSync('.env', 'utf8'))?.[1]?.trim().replace(/^["']|["']$/g, '')
      : undefined;

    for (const f of list) {
      const text = entries.get(f)!;
      // The client names the api_key parameter, so only the worker may mention it; no file holds a value for it.
      if (f !== 'background.js') expect(text.includes('api_key'), `${f} mentions api_key`).toBe(false);
      expect(/api_key=[A-Za-z0-9]{16,}/.test(text), `${f} holds an api_key value`).toBe(false);
      expect(/\b[0-9a-f]{64}\b/.test(text), `${f} holds a 64-character hex string`).toBe(false);
      if (envKey && envKey.length >= 8) expect(text.includes(envKey), `${f} holds the .env key`).toBe(false);
      expect(text.includes('localhost'), `${f} mentions localhost`).toBe(false);
      // The paired app is the one loopback address the extension may name (docs/decisions.md, step 13), and only its port.
      for (const m of text.matchAll(/127\.0\.0\.1(?!:8790)/g)) expect.fail(`${f} names 127.0.0.1 without port 8790 at ${m.index}`);
      expect(text.includes('sourceMappingURL'), `${f} points at a source map`).toBe(false);
      expect(text.includes('/Users/'), `${f} holds an absolute path`).toBe(false);
      expect(text.includes('.output-e2e'), `${f} names the end-to-end build`).toBe(false);
    }

    expect(readdirSync('output').filter((f) => f === name)).toHaveLength(1);
  }, 240_000);
});
