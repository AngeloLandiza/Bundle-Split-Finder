import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBundlePage, parsePageSections } from '../src/hdPage';

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

describe('parsePageSections (step 12, R2)', () => {
  it('reads title, model, bullets and description of a recorded 2-tool RYOBI page', () => {
    const got = parsePageSections(page('328814689').text);
    expect(got?.title).toBe('ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only)');
    expect(got?.model).toBe('PBLRC2501SB');
    expect(got?.description).toContain('2-Tool Combo Kit');
    expect(got?.bullets[0]).toContain('1/4" Ratchet');
  });

  it('gives the same bullets and description as parseBundlePage, for every recorded 200 page, with or without the item id', () => {
    for (const p of pages.filter((r) => r.status === 200)) {
      const sections = parsePageSections(p.text);
      const content = parseBundlePage(p.text, p.itemId);
      expect(sections, p.itemId).not.toBeNull();
      expect(sections?.bullets).toEqual(content?.bullets);
      expect(sections?.description).toBe(content?.description);
      expect(parsePageSections(p.text, p.itemId)).toEqual(sections);
      expect(sections?.title).not.toBe('');
      expect(sections?.model).not.toBe('');
    }
  });

  it('is null for the refused page and for text with no page data', () => {
    expect(parsePageSections(refused)).toBeNull();
    expect(parsePageSections('')).toBeNull();
    expect(parsePageSections('window.__APOLLO_STATE__={"ROOT_QUERY":{}}')).toBeNull();
  });

  it('is null when asked for an item id the page does not hold', () => {
    expect(parsePageSections(page('328814689').text, '000000000')).toBeNull();
  });

  it('lists no specifications: no recorded page holds specification groups (to record: see the R2 report)', () => {
    for (const p of pages.filter((r) => r.status === 200)) expect(parsePageSections(p.text)?.specifications).toEqual([]);
  });
});
