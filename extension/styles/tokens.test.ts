import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const spec = readFileSync(resolve(root, 'docs/design.md'), 'utf8');
const css = readFileSync(resolve(root, 'extension/styles/tokens.css'), 'utf8');

function specTokens(): Record<string, string> {
  const block = spec.split('## Tokens')[1]?.split(/\n## /)[0] ?? '';
  const out: Record<string, string> = {};
  const line = /^\s+--([\w-]+):\s+(#[0-9A-Fa-f]{6})(?:\s+on\s+(#[0-9A-Fa-f]{6}))?/gm;
  for (const m of block.matchAll(line)) {
    out[m[1]!] = m[2]!.toLowerCase();
    // The spec writes the attention pair on one line: "--attention: #FG on #BG".
    if (m[3]) out[`${m[1]}-bg`] = m[3].toLowerCase();
  }
  return out;
}

function cssValue(name: string): string | undefined {
  return css.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})\\s*;`))?.[1]?.toLowerCase();
}

describe('tokens.css', () => {
  const tokens = specTokens();

  it('reads all twelve color tokens from the spec', () => {
    expect(Object.keys(tokens).sort()).toEqual(
      [
        'attention',
        'attention-bg',
        'ink',
        'ink-2',
        'ink-3',
        'line',
        'line-strong',
        'link',
        'loss',
        'paper',
        'sunken',
        'surface',
      ].sort(),
    );
  });

  for (const [name, hex] of Object.entries(tokens)) {
    it(`defines --${name} as ${hex}`, () => {
      expect(cssValue(name)).toBe(hex);
    });
  }

  it('has exactly six @font-face blocks', () => {
    expect(css.match(/@font-face\s*\{/g)?.length).toBe(6);
  });

  it('points every url() at a file under public/', () => {
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u.startsWith('/'), u).toBe(true);
      expect(existsSync(resolve(root, 'public', u.slice(1))), u).toBe(true);
    }
  });
});
