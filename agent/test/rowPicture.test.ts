// Product pictures (Nov 25): a deal row carries the stored Amazon picture of its first part, from the real store after
// six scans (fixtures/e2e-2026-11-23/after-scan6), and nothing else: no Home Depot picture is stored, none is guessed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { dealsResponse } from '../views';

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6', 'store');
const read = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as unknown;

describe('a deal row’s picture', () => {
  const data = {
    deals: read('deals.json'),
    review: read('review.json'),
    tracking: read('tracking.json'),
    runtime: {},
    settings: { settings: { searchesPerScan: 20 } },
  } as unknown as Parameters<typeof dealsResponse>[0];
  const rows = dealsResponse(data, { sort: 'profit' }, new Date(2026, 10, 25, 12).getTime()).rows;
  const bundles = (read('deals.json') as { bundles: { key: string; parts: { image: string | null }[] }[] }).bundles;

  it('is the first part’s stored picture, on 46 of the 258 rows', () => {
    expect(rows).toHaveLength(258);
    const withPicture = rows.filter((r) => r.image);
    expect(withPicture).toHaveLength(46);
    for (const r of withPicture) {
      expect(new URL(r.image!).hostname).toBe('m.media-amazon.com');
      expect(r.image).toBe(bundles.find((b) => b.key === r.id)!.parts[0]!.image);
    }
  });

  it('is absent when the first part has none, even when a later part has one', () => {
    const later = bundles.find((b) => b.parts.length > 1 && !b.parts[0]!.image && b.parts.some((p) => p.image));
    expect(later).toBeDefined();
    expect(rows.find((r) => r.id === later!.key)!.image).toBeUndefined();
  });

  it('Nov 25: is the bundle’s own Home Depot picture first, and the list says how many deals and parts have one', () => {
    const HD = 'https://images.thdstatic.com/productImages/b16b4743-d4cf-4c84-b731-5ccd3e2cc507/svn/ryobi-power-tool-combo-kits-pcl1600k2-64_145.jpg';
    const deals = read('deals.json') as { bundles: { key: string; image?: string; parts: { image: string | null }[] }[] };
    const withPart = deals.bundles.find((b) => b.parts[0]?.image)!;
    const withNone = deals.bundles.find((b) => b.parts.every((p) => !p.image))!;
    const changed = { ...deals, bundles: deals.bundles.map((b) => (b.key === withPart.key || b.key === withNone.key ? { ...b, image: HD } : b)) };
    const res = dealsResponse({ ...data, deals: changed } as unknown as Parameters<typeof dealsResponse>[0], { sort: 'profit' }, new Date(2026, 10, 25, 12).getTime());
    expect(res.rows.find((r) => r.id === withPart.key)!.image).toBe(HD);
    expect(res.rows.find((r) => r.id === withNone.key)!.image).toBe(HD);
    expect(res.pictures).toEqual({ deals: 47, dealsOf: 258, parts: 46, partsOf: 153 });
    // A stored address off the image hosts is no picture: the row falls back to its first part's.
    const bad = { ...deals, bundles: deals.bundles.map((b) => (b.key === withPart.key ? { ...b, image: 'https://evil.example/x.jpg' } : b)) };
    const res2 = dealsResponse({ ...data, deals: bad } as unknown as Parameters<typeof dealsResponse>[0], { sort: 'profit' }, new Date(2026, 10, 25, 12).getTime());
    expect(res2.rows.find((r) => r.id === withPart.key)!.image).toBe(withPart.parts[0]!.image);
  });
});
