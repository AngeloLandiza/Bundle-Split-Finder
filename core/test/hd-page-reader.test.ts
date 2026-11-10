import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBundlePage } from '../src/hdPage';

interface Rec { itemId: string; status: number; text: string }
const pages = (
  JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pages-2026-11-10.json', import.meta.url), 'utf8')) as {
    pages: Rec[];
  }
).pages;
const refused = readFileSync(new URL('../../fixtures/homedepot-pages/refused-2026-11-10.html', import.meta.url), 'utf8');
const page = (id: string): Rec => {
  const r = pages.find((p) => p.itemId === id);
  if (!r) throw new Error(`no recorded page ${id}`);
  return r;
};

describe('parseBundlePage', () => {
  it('reads the bullets of a RYOBI kit', () => {
    const got = parseBundlePage(page('320683876').text, '320683876');
    expect(got?.bullets.some((b) => b.startsWith('Includes: (1) PBLRC25 18V'))).toBe(true);
  });

  it('keeps page order', () => {
    const got = parseBundlePage(page('337440459').text, '337440459');
    const hits = got?.bullets.filter((b) => b.startsWith('DCF921B:')) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(3);
    const raw = page('337440459').text;
    const at = got!.bullets.map((b) => raw.indexOf(JSON.stringify(b).slice(1, -1)));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('reads the description', () => {
    expect(parseBundlePage(page('324904496').text, '324904496')?.description).toContain('PCL206');
  });

  it('parses every recorded 200 page, bullets all strings', () => {
    for (const p of pages.filter((r) => r.status === 200)) {
      const got = parseBundlePage(p.text, p.itemId);
      expect(got, p.itemId).not.toBeNull();
      expect(got!.bullets.every((b) => typeof b === 'string')).toBe(true);
    }
  });

  it('returns null for the refused page', () => {
    expect(parseBundlePage(refused, '320683876')).toBeNull();
  });

  it('returns null when the text is for another item', () => {
    expect(parseBundlePage(page('320683876').text, '337440459')).toBeNull();
  });

  it('returns null for text cut in half', () => {
    const t = page('320683876').text;
    expect(parseBundlePage(t.slice(0, Math.floor(t.length / 2)), '320683876')).toBeNull();
  });

  it('handles braces and escaped quotes inside strings', () => {
    const text = 'window.__APOLLO_STATE__={"base-catalog-1":{"details":{"description":"a } \\" { b","descriptiveAttributes":[{"value":"x}"},{"value":7},{"value":"y"}]}}};\nzz';
    expect(parseBundlePage(text, '1')).toEqual({ bullets: ['x}', 'y'], description: 'a } " { b' });
  });
});
