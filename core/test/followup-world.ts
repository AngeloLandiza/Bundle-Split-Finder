// Step 16: the constructed Home Depot of the follow-up loop's tests (core/test/research-followup.test.ts,
// agent/test/followUp.test.ts). No recording of these three models' rows and pages exists: each title and Includes line
// is made of the words of the real bundle page of PCL406424SB-A21701-A25RS51 (item 335724135, as the owner's scan 3
// stored it in fixtures/e2e-2026-11-23/after-scan3), so a test reads them as Home Depot would show them.

import type { HomeDepotPage, HomeDepotSearch, ResearchTools } from '../src/research/types';

export const HD = 'https://www.homedepot.com';

// Constructed rows and pages (see the header): the titles are the bundle page's own words for each part.
export const ROWS: Record<string, { itemId: string; title: string; bullets: string[] }> = {
  A21701: { itemId: '317000001', title: '5 in. 7-Piece Random Orbit Sand Paper Assortment Set', bullets: ['Includes: (3) 80 grit, (2) 120 grit, and (2) 220 grit'] },
  A25RS51: { itemId: '317000002', title: 'Straight Router Bit Set (5-Piece)', bullets: ['Includes: 1/4 in., 3/8 in., 1/2 in., 5/8 in. straight router bits with a bonus 5/16 in. bit'] },
  PCL406424SB: {
    itemId: '317000003', title: 'ONE+ 18V Cordless 2-Tool Combo Kit w/ Compact Fixed Base Router & 5 in. Random Orbit Sander (Tools Only)',
    bullets: ['Includes: 18V ONE+ Cordless Compact Router, (1) collet wrench, (1) vacuum Dust Chute, 18V 5" Random Orbit Sander, (3) Pieces of Sandpaper Assortment, Dust Collection Bag, and Operator\'s Manuals'],
  },
};

export interface Calls { searches: string[]; pages: string[] }

/** Home Depot as the loop would find it with a warm tab: a search for "RYOBI <model>" gives the model's row, its page reads. */
export function warmTools(calls: Calls, opts: { failSearch?: boolean; failAll?: boolean } = {}): ResearchTools {
  return {
    async searchHomeDepot({ query }) {
      calls.searches.push(query);
      if (opts.failSearch || opts.failAll) return { error: 'Chrome did not answer in time.' };
      const m = /^RYOBI\s+(\S+)$/i.exec(query.trim())?.[1]?.toUpperCase();
      const row = m ? ROWS[m] : undefined;
      const s: HomeDepotSearch = {
        sourceId: `hd-search:ryobi-${(m ?? 'x').toLowerCase()}`, label: 'Home Depot search', url: `${HD}/s/${encodeURIComponent(query)}`,
        results: row ? [{ title: row.title, brand: 'RYOBI', model: m!, itemId: row.itemId, url: `${HD}/p/${row.itemId}` }] : [],
      };
      return s;
    },
    async readHomeDepotPage({ itemId }) {
      calls.pages.push(itemId ?? '');
      if (opts.failAll) return { error: 'Home Depot refused the page (HTTP 403).' };
      const [model, row] = Object.entries(ROWS).find(([, r]) => r.itemId === itemId) ?? [];
      if (!row) return { error: 'not recorded' };
      const page: HomeDepotPage = {
        sourceId: `hd-page:${itemId}`, label: 'Home Depot page', url: `${HD}/p/${itemId}`,
        sections: { title: row.title, model: model!, bullets: row.bullets, description: '', specifications: [] },
      };
      return page;
    },
    async catalogLookup() {
      return { sourceId: 'catalog:none', entries: [] };
    },
  };
}

