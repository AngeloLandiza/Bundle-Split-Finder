// Local agent prototype (plan Phase 3): core scan + optional Keepa from recorded responses.
// npm run agent:scan -- --fixtures [--keepa]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TokenBudget } from '../core/src/keepa/budget';
import { KeepaClient } from '../core/src/keepa/client';
import { keepaLookupSearchResult, keepaProductSearchResult } from '../core/src/keepa/fetchStep';
import type { KeepaScaleSettings } from '../core/src/keepa/plan';
import { writePartTrend } from '../core/src/keepa/trends';
import { MemoryScanStore } from '../core/src/scan/memoryStore';
import { postScanWork } from '../core/src/scan/postScan';
import { runScan } from '../core/src/scan/runner';
import { DEFAULT_SCAN_SETTINGS } from '../core/src/scan/types';
import { parseAccount } from '../core/src/serpapi/budget';
import { SearchBudget } from '../core/src/serpapi/budget';
import { MemoryCache, type SearchResult, SerpApiClient } from '../core/src/serpapi/client';
import { reviewDigestMessage } from '../core/src/keepa/alerts';
import { agentNotifyText } from './notify';

const fixtures = process.argv.includes('--fixtures');
const withKeepa = process.argv.includes('--keepa');
const intervalIdx = process.argv.indexOf('--interval');
const intervalMin = intervalIdx >= 0 ? Math.max(0, Number(process.argv[intervalIdx + 1] ?? 0)) : 0;

const agentCache = new MemoryCache();

function loadKeepaFixture(): void {
  const path = fileURLToPath(new URL('../fixtures/keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB.json', import.meta.url));
  const body = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const key = 'keepa:product?asin=B0BGYFTPGK&domain=1&history=0';
  void agentCache.set(key, { at: Date.now(), data: body });
}

async function runOnce(): Promise<void> {
  if (!fixtures) {
    console.error('Prototype agent runs on fixtures only. Use: npm run agent:scan -- --fixtures');
    process.exit(1);
  }
  const key = 'fixture-agent';
  const account = parseAccount({ plan_name: 'Free', total_searches_left: 5, plan_searches_per_month: 250, this_month_usage: 0, searches_per_hour: 50, plan_searches_per_hour: 50, account_status: 'active' });
  const budget = new SearchBudget(account, { reserve: 0, maxPerRun: 2 });
  const client = new SerpApiClient({ apiKey: key, budget, cache: agentCache });
  const store = new MemoryScanStore();
  const settings = { ...DEFAULT_SCAN_SETTINGS, amazonRefreshViaKeepa: withKeepa };
  let keepaProduct: ((asin: string, label: string, maxAgeMs?: number) => Promise<SearchResult>) | undefined;
  let keepaLookup: ((brand: string, model: string, label: string) => Promise<SearchResult>) | undefined;
  let keepaBudget: TokenBudget | undefined;
  let keepaScale: KeepaScaleSettings | undefined;
  if (withKeepa) {
    loadKeepaFixture();
    keepaBudget = new TokenBudget({ reserve: 0, maxPerRun: 5 });
    const keepa = new KeepaClient({ apiKey: 'fixture', budget: keepaBudget, cache: agentCache });
    keepaProduct = (asin, label, maxAgeMs) => keepaProductSearchResult(keepa, asin, { label, maxAgeMs });
    keepaLookup = (brand, model, label) => keepaLookupSearchResult(keepa, `${brand} ${model}`, { label });
    keepaScale = { tokensPerRun: 5, discoveryShare: 90, reserve: 0, mode: 'auto' };
  }
  const ended = await runScan({
    client,
    budget,
    store,
    settings,
    labelPrefix: 'agent',
    keepaProduct,
    keepaLookup,
    keepaBudget,
    keepaScale,
    cache: agentCache,
    trendWriter: withKeepa ? (t) => writePartTrend(agentCache, t) : undefined,
  });
  const { report, snapshotCount } = await postScanWork({ store, settings, cache: agentCache, now: () => Date.now() });
  const outPath = fileURLToPath(new URL('../output/agent-last-scan.json', import.meta.url));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        ok: true,
        at: new Date().toISOString(),
        ended,
        summary: {
          bundles: report.bundles.length,
          confirmed: report.bundles.filter((b) => b.section === 'confirmed').length,
          reviewOpen: report.review.filter((q) => q.answer === null).length,
          deferredLookups: ended.deferred.filter((s) => s.kind === 'lookup').length,
          deferredRefreshes: ended.deferred.filter((s) => s.kind === 'refresh').length,
          snapshots: snapshotCount,
          serpSearches: ended.searchesUsed,
          keepaTokens: ended.keepaTokensUsed ?? 0,
          keepaPlan: ended.keepaPlan ?? null,
        },
      },
      null,
      2,
    ),
  );
  console.log(`Agent scan ended: ${ended.status}, SerpApi searches ${ended.searchesUsed}, Keepa tokens ${ended.keepaTokensUsed ?? 0}`);
  console.log(`Wrote ${outPath}`);
  const review = report.review.filter((q) => q.answer === null);
  const digest = reviewDigestMessage({
    match: review.filter((q) => q.kind === 'match').length,
    split: review.filter((q) => q.kind === 'split').length,
  });
  const defer = ended.deferred.length;
  if (digest) agentNotifyText(digest);
  else if (defer > 0) agentNotifyText(`${defer} scan steps deferred for the next run.`);
}

async function main(): Promise<void> {
  if (intervalMin > 0) {
    console.log(`Agent scan every ${intervalMin} minute(s). First run now.`);
    for (;;) {
      await runOnce();
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMin * 60_000));
    }
  }
  await runOnce();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});