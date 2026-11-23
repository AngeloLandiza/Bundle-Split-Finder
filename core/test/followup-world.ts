// Step 16: the Home Depot of the follow-up loop's tests (core/test/research-followup.test.ts, agent/test/followUp.test.ts),
// RECORDED: the owner's Chrome read it free through the installed app's worker jobs on Nov 23 2026
// (fixtures/homedepot-pages/followup-PCL406424SB-2026-11-23.json): Home Depot's search for "RYOBI PCL406424SB" (its own
// product, item 328690521), "RYOBI A21701" (item 316546864), "RYOBI A25RS51" and "A25RS51" (no rows), and the pages of
// 328690521, 316546864 and the bundle 335724135. A search or page the recording does not hold answers "not recorded".

import { readFileSync } from 'node:fs';

import type { HomeDepotPage, HomeDepotSearch, ResearchTools } from '../src/research/types';

export const HD = 'https://www.homedepot.com';
export const RECORDING = 'fixtures/homedepot-pages/followup-PCL406424SB-2026-11-23.json';

interface Call { kind: 'search' | 'researchPage'; input: { query?: string; itemId?: string }; status: string; result: unknown }
const calls = (JSON.parse(readFileSync(RECORDING, 'utf8')) as { calls: Call[] }).calls;
const key = (q: string): string => q.trim().toLowerCase().replace(/\s+/g, ' ');
export const SEARCHES = new Map(calls.filter((c) => c.kind === 'search').map((c) => [key(c.input.query!), c.result as HomeDepotSearch] as const));
export const PAGES = new Map(calls.filter((c) => c.kind === 'researchPage').map((c) => [c.input.itemId!, c.result as HomeDepotPage] as const));

export interface Calls { searches: string[]; pages: string[] }

/** Home Depot as the recording answers it; `failAll`: every read fails (a closed tab). */
export function recordedHomeDepot(calls: Calls, opts: { failAll?: boolean } = {}): ResearchTools {
  return {
    async searchHomeDepot({ query }) {
      calls.searches.push(query);
      if (opts.failAll) return { error: 'Chrome did not answer in time.' };
      return structuredClone(SEARCHES.get(key(query))) ?? { error: 'not recorded' };
    },
    async readHomeDepotPage({ itemId }) {
      calls.pages.push(itemId ?? '');
      if (opts.failAll) return { error: 'Home Depot refused the page (HTTP 403).' };
      return structuredClone(PAGES.get(itemId ?? '')) ?? { error: 'not recorded' };
    },
    async catalogLookup() {
      return { sourceId: 'catalog:none', entries: [] };
    },
  };
}
