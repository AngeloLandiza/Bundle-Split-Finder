import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBundlePage, parsePageSections, parsePageState, parseSearchState, parseSearchText } from '../src/hdPage';

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

/** details.highlights of a recorded page, as its text holds them (each recording holds one product; no highlight holds a "]"). */
const highlightsOf = (r: Rec): string[] => {
  const m = /"highlights":(\[[^\]]*\]|null)/.exec(r.text);
  const h = m ? (JSON.parse(m[1]!) as unknown) : null;
  return Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string') : [];
};

describe('parsePageSections (step 12, R2)', () => {
  it('reads title, model, bullets and description of a recorded 2-tool RYOBI page', () => {
    const got = parsePageSections(page('328814689').text);
    expect(got?.title).toBe('ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only)');
    expect(got?.model).toBe('PBLRC2501SB');
    expect(got?.description).toContain('2-Tool Combo Kit');
    // The highlights first, then the descriptive bullets.
    expect(got?.bullets.slice(0, 3)).toEqual(['Slim Head and Extended Reach', 'Includes: 1/4" and 3/8" Extended Reach Ratchets', 'Over 300 ONE+ Products – All Work With Any RYOBI ONE+ 18V Battery']);
    expect(got?.bullets[3]).toContain('1/4" Ratchet');
  });

  it('gives the highlights, then the same bullets as parseBundlePage, and its description, for every recorded 200 page, with or without the item id', () => {
    for (const p of pages.filter((r) => r.status === 200)) {
      const sections = parsePageSections(p.text);
      const content = parseBundlePage(p.text, p.itemId);
      const highlights = highlightsOf(p);
      expect(sections, p.itemId).not.toBeNull();
      expect(sections?.bullets).toEqual([...highlights.filter((h) => !content!.bullets.includes(h)), ...content!.bullets]);
      expect(sections?.description).toBe(content?.description ?? '');
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

  it('lists no specifications for the older, cut-down recordings, which hold no specification group', () => {
    for (const p of pages.filter((r) => r.status === 200)) expect(parsePageSections(p.text)?.specifications).toEqual([]);
  });
});

interface Research {
  pages: Record<string, Record<string, unknown>>;
  searches: Record<string, { status: number; finalPath: string; state: Record<string, unknown> }>;
}
const research = JSON.parse(
  readFileSync(new URL('../../fixtures/homedepot-pages/research-2026-11-20.json', import.meta.url), 'utf8'),
) as Research;
const specsOf = (id: string) => parsePageState(research.pages[id], id)?.specifications ?? [];
const valueOf = (id: string, name: string) => specsOf(id).filter((s) => s.name === name).map((s) => s.value);

describe('parsePageState on the research recordings (Nov 20)', () => {
  it('reads PCL500525SB: a 2-tool tools-only kit, no battery, no charger', () => {
    const got = parsePageState(research.pages['328690510'], '328690510');
    expect(got?.model).toBe('PCL500525SB');
    expect(got?.title).toContain('(Tools Only)');
    expect(valueOf('328690510', 'Tools Included')).toEqual(['Circular Saw,Jig Saw']);
    expect(valueOf('328690510', 'Number of Tools (Bonus Tool Not Included)')).toEqual(['2']);
    expect(valueOf('328690510', 'Number of Total Batteries Included')).toEqual(['0']);
    expect(valueOf('328690510', 'Charger Included')).toEqual(['Charger Not Included']);
    // Groups are flattened in page order: Details, then Warranty / Certifications.
    expect(specsOf('328690510')[0]).toEqual({ name: 'Battery Power Type', value: 'Lithium Ion' });
  });

  it('reads the Included spec of the other recorded pages', () => {
    expect(valueOf('328814689', 'Included')).toEqual(['Tool Only']);
    expect(valueOf('341645081', 'Included')).toEqual(['Battery Included,Blade(s),Charger']);
    expect(valueOf('341645081', 'Number of Tools (Bonus Tool Not Included)')).toEqual(['6']);
    expect(valueOf('339206615', 'Number of Total Batteries Included')).toEqual(['2']);
  });

  it('keeps the bullets and description, and finds the product without an item id', () => {
    const withId = parsePageState(research.pages['328814689'], '328814689');
    expect(withId?.bullets.some((b) => b.includes('PBLRC01') && b.includes('PBLRC25'))).toBe(true);
    expect(parsePageState(research.pages['328814689'])).toEqual(withId);
    expect(parsePageState(research.pages['328814689'], '1')).toBeNull();
    expect(parsePageState(null)).toBeNull();
  });

  it('gives every recorded specification as a non-empty name and value', () => {
    for (const id of Object.keys(research.pages)) {
      expect(specsOf(id).length, id).toBeGreaterThan(5);
      for (const s of specsOf(id)) expect(s.name !== '' && s.value !== '').toBe(true);
    }
  });

  it('reads the same through the page text', () => {
    const text = `window.__APOLLO_STATE__=${JSON.stringify(research.pages['328690510'])}</script>`;
    expect(parsePageSections(text, '328690510')).toEqual(parsePageState(research.pages['328690510'], '328690510'));
  });
});

describe('parseSearchState on the research recordings (Nov 20)', () => {
  const search = (q: string) => parseSearchState(research.searches[q]?.state);

  it('lists "ryobi pcl500" in page order: the saw first, the combo kit with its item id', () => {
    const got = search('ryobi pcl500');
    expect(got).toHaveLength(12);
    expect(got[0]).toMatchObject({ brand: 'RYOBI', model: 'PCL500B', itemId: '317987588' });
    const kit = got.find((r) => r.model === 'PCL500B-PCL525B');
    expect(kit?.itemId).toBe('324616618');
    expect(kit?.url).toBe(`https://www.homedepot.com${(research.searches['ryobi pcl500']!.state['base-searchNav-324616618'] as { identifiers: { canonicalUrl: string } }).identifiers.canonicalUrl}`);
    expect(got.map((r) => r.itemId)).toEqual(
      Object.keys(research.searches['ryobi pcl500']!.state).map((k) => k.replace('base-searchNav-', '')),
    );
  });

  it('finds the kit by its own model, and a model search lists the kit it names', () => {
    expect(search('PCL500525SB').map((r) => r.model)).toContain('PCL500525SB');
    expect(search('PCL1600K2').some((r) => r.model.startsWith('PCL1600K2'))).toBe(true);
    expect(search('dewalt dck240c2').length).toBeGreaterThan(0);
  });

  it('returns what Home Depot returned for a query it cannot answer; relevance is the reader\'s', () => {
    expect(search('zzqx notaproduct 98765').length).toBeGreaterThan(0);
  });

  it('gives every entry a brand, model, title and /p/ address', () => {
    for (const q of Object.keys(research.searches)) {
      for (const r of search(q)) {
        expect(r.itemId).toMatch(/^\d+$/);
        expect(r.model).not.toBe('');
        expect(r.title).not.toBe('');
        expect(r.url).toMatch(/^https:\/\/www\.homedepot\.com\/p\/.+\/\d+$/);
      }
    }
  });

  it('is empty for a state with no search entries, and parseSearchText reads the page text', () => {
    expect(parseSearchState({})).toEqual([]);
    expect(parseSearchState(null)).toEqual([]);
    const text = `window.__APOLLO_STATE__=${JSON.stringify(research.searches['ryobi pcl500']!.state)}`;
    expect(parseSearchText(text)).toEqual(search('ryobi pcl500'));
    expect(parseSearchText('<html>no data</html>')).toBeNull();
  });
});
