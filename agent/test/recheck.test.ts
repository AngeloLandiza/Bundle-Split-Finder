// The app replaces a wrong listing itself, replayed on the owner's records after his sixth scan (fixtures/e2e-2026-11-23/
// after-scan6) as the agent runs it at start (agent/recheck.ts selfCorrect after the price guard, then the drip's pulls):
// what happens to the five deals the price guard and the audit stopped (DWST08017's set; B0FD253MKS's three sets and one
// bundle) and to the question count. No scan, no search, no AI; the Keepa pull is a fake.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import { matchState } from '../../core/src/scan/matchState';
import { applyPriceGuard } from '../../core/src/scan/priceGuard';
import { runRechecks } from '../../core/src/scan/recheck';
import { buildReport } from '../../core/src/scan/report';
import { rejudgePackQuestions, withdrawUnreadSplitQuestions } from '../../core/src/scan/runner';
import { knownModels } from '../../core/src/scan/split';
import { DEFAULT_SCAN_SETTINGS, type BundleRow, type ScanStore } from '../../core/src/scan/types';
import type { KeepaProduct } from '../../core/src/keepa/types';
import { dripPull, KEEPA_TOKENS, NEXT_KEEPA_READ, selfCorrect } from '../recheck';
import { defaultSettings } from '../store';
import { recheckFollowUp, reviewResponse } from '../views';

const ROOT = join(import.meta.dirname, '..', '..');
const AFTER_SCAN6 = join(ROOT, 'fixtures', 'e2e-2026-11-23', 'after-scan6');
const NOW = 1795600000000;
const FIVE = ['homedepot:339422000', 'homedepot:339349594', 'homedepot:339349600', 'homedepot:339349659', 'homedepot:344284497'];

/** The agent's start on the stored records: its start rules (Nov 24), the price guard, then selfCorrect. */
async function start(keepa: boolean): Promise<{ store: ScanStore; done: Awaited<ReturnType<typeof selfCorrect>> }> {
  const store = await loadScanFolder(AFTER_SCAN6);
  await withdrawUnreadSplitQuestions(store, NOW);
  await rejudgePackQuestions(store, DEFAULT_SCAN_SETTINGS, () => NOW);
  await applyPriceGuard(store, NOW);
  const deals = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles;
  const done = await selfCorrect({ store, catalog: (await knownModels(store)).catalog, now: () => NOW, keepa, cleared: [] }, deals);
  return { store, done };
}

const open = async (store: ScanStore) => (await store.listReview()).filter((q) => q.answer === null).map((q) => q.model).sort();
const rows = async (store: ScanStore): Promise<Map<string, BundleRow>> => new Map((await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.map((b) => [b.key, b]));

describe('replay on after-scan6, with Keepa (the owner\'s setup)', () => {
  it('at start: DWST08017\'s question becomes a re-check, B0FD253MKS is withdrawn for both vacuums; 13 questions become 12', async () => {
    const { store, done } = await start(true);
    expect(done.held).toEqual(['DEWALT:DWST08017']);
    expect(done.withdrawn).toEqual(['RYOBI:PCL700B', 'RYOBI:PCL702B']);
    // Free tries only: B0C3TN1Z7P from its recorded catalog check; every other candidate waits for the drip's pull.
    expect(done.ran.tried).toBe(1);
    expect((await store.getRecheck!('DEWALT:DWST08017'))!).toMatchObject({ stage: 'trying', waitingFor: NEXT_KEEPA_READ });
    expect(await open(store)).toEqual([
      'DCK225D2WCS354B', 'DCK225D2WCS356B', 'DCK225D2WCS380B', 'DCK225D2WCS391B', 'DCKTS681D1P1W21', 'DCKTS681D1P1W82',
      'PCL1600K2-A965201', 'PCL1600K2-A986501', 'PCL406416SB', 'PCL406416SB-A21701-A21C901', 'PCL406424SB', 'PCL406424SB-A21701-A25RS51',
    ]);
    const all = await rows(store);
    for (const id of FIVE) {
      const b = all.get(id)!;
      // No estimate, so no Buy now: the existing rule for a part with no confirmed listing; and no question.
      expect(b.estimate).toBeNull();
      expect(matchState(b)).toBe('1 listing being re-checked');
    }
    expect(all.get('homedepot:344284497')!.parts.find((p) => p.model === 'PCL702B')!.recheck!.sentence).toBe(
      'Being re-checked: B0FD253MKS was withdrawn (The same Amazon listing is counted for PCL702B and for PCL700B; one listing cannot be both.); 1 more listing to try, waiting for the next Keepa read.',
    );
  });

  it('the drip with its tokens at the reserve: nothing is pulled, every part waits for Keepa tokens, still no question', async () => {
    const { store } = await start(true);
    let tokens = 0;
    const pulls: string[] = [];
    const product = async (asin: string) => {
      pulls.push(asin);
      return { data: null, source: 'network' as const, at: NOW };
    };
    const done = await runRechecks({
      store, catalog: (await knownModels(store)).catalog, now: () => NOW,
      pull: dripPull(store, { blockReason: () => 'reserve' }, product, (t) => { tokens += t; }),
    });
    expect(pulls).toEqual([]);
    expect(tokens).toBe(0);
    expect(done).toMatchObject({ replaced: [], lookups: [], asked: [] });
    for (const k of ['DEWALT:DWST08017', 'RYOBI:PCL700B', 'RYOBI:PCL702B']) expect((await store.getRecheck!(k))!.waitingFor).toBe(KEEPA_TOKENS);
    expect(await open(store)).toHaveLength(12);
  });

  it('the drip\'s pull: one token, the price saved, Amazon\'s fields read (the recorded B0DGLWKS9S record)', async () => {
    const store = await loadScanFolder(AFTER_SCAN6);
    const rec = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'keepa', 'catalog-wrong-part-number-B0DGLWKS9S.json'), 'utf8')) as { product: KeepaProduct };
    let tokens = 0;
    const pull = dripPull(store, { blockReason: () => null }, async () => ({ data: null, source: 'network', at: NOW, keepaTokens: 1, keepaProduct: rec.product }), (t) => { tokens += t; });
    const id = await pull('B0DGLWKS9S', 'DWST08017');
    expect(id).toMatchObject({ asin: 'B0DGLWKS9S', brand: 'DEWALT', partNumber: 'DWST08017', source: 'keepa_catalog' });
    expect(tokens).toBe(1);
  });
});

describe('replay on after-scan6, without Keepa (the stored rows read by rung 1)', () => {
  it('PCL702B takes B0BH6Q31MZ by itself; PCL700B and DWST08017 join the lookup queue; still 12 questions', async () => {
    const { store, done } = await start(false);
    expect(done.ran.replaced.map((r) => [r.key, r.to])).toEqual([['RYOBI:PCL702B', 'B0BH6Q31MZ']]);
    expect(done.ran.lookups.sort()).toEqual(['DEWALT:DWST08017', 'RYOBI:PCL700B']);
    expect((await store.getMatch('RYOBI:PCL702B'))!).toMatchObject({ status: 'matched', asin: 'B0BH6Q31MZ', grade: 'strong', verifiedBy: 'listing_fields' });
    expect((await store.getRecheck!('DEWALT:DWST08017'))!.tried.map((t) => [t.asin, t.passed])).toEqual([
      ['B0C3TN1Z7P', false], ['B0HMV5V9L7', false], ['B0HQQZWYTX', false], ['B0CHWF4JM9', false], ['B0DR93VQBD', false],
    ]);
    expect(await open(store)).toHaveLength(12);
    const all = await rows(store);
    // PCL702B's bundle now has a confirmed listing with no Amazon price yet: still no estimate until its price is read.
    const pcl702b = all.get('homedepot:344284497')!.parts.find((p) => p.model === 'PCL702B')!;
    expect(pcl702b).toMatchObject({ asin: 'B0BH6Q31MZ', verifiedBy: 'listing_fields' });
    expect(pcl702b.recheck).toBeUndefined();
    expect(all.get('homedepot:344284497')!.estimate).toBeNull();
    // The others wait for a fresh lookup (section "waiting"), not a question.
    for (const id of FIVE.slice(0, 4)) expect(all.get(id)!.section).toBe('waiting');
  });

  it('when the lookup then finds nothing, the question opens and its card lists every listing tried and why', async () => {
    const { store } = await start(false);
    const m = (await store.getMatch('DEWALT:DWST08017'))!;
    await store.putMatch({ ...m, status: 'none', waitingSince: null });
    const done = await runRechecks({ store, catalog: (await knownModels(store)).catalog, now: () => NOW });
    expect(done.asked).toEqual(['DEWALT:DWST08017']);
    const report = await buildReport(store, DEFAULT_SCAN_SETTINGS);
    const view = reviewResponse({
      review: { at: null, questions: report.review, ebayQuestions: [] }, suggestions: [], deals: { bundles: report.bundles }, settings: defaultSettings(),
    } as unknown as Parameters<typeof reviewResponse>[0]);
    const q = view.questions.find((x) => x.id === 'match:DEWALT:DWST08017')!;
    expect(q.reason).toBe('The listing was withdrawn; the app tried 5 other listings and none could be confirmed');
    expect(q.followUp).toEqual(recheckFollowUp(q.item.question as never));
    expect(q.followUp!.tried[0]).toEqual({ what: 'Tried B0C3TN1Z7P', result: "Amazon's catalog lists no part number that is DWST08017", url: 'https://www.amazon.com/dp/B0C3TN1Z7P' });
    expect(q.followUp!.state).toBe('gave_up');
    expect(q.brief!.check!.text).toContain('The app already read what it could for this (5 steps)');
    // Every listing is still the owner's to choose, the withdrawn backpack first with why.
    expect(q.choices!.map((c) => c.asin)).toEqual(['B0DGLWKS9S', 'B0C3TN1Z7P', 'B0HMV5V9L7', 'B0HQQZWYTX', 'B0CHWF4JM9', 'B0DR93VQBD']);
    expect(await open(store)).toHaveLength(13);
  });
});
