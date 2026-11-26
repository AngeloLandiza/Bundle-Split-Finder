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
});
