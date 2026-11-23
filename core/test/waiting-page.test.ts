import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseBundlePage } from '../src/hdPage';
import { matchState, WAITING_PAGE_TEXT } from '../src/scan/matchState';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { RESOLVED_BY_SCAN } from '../src/scan/answers';
import { splitOne, withdrawUnreadSplitQuestions } from '../src/scan/runner';
import { bundleKey, type BundleRecord, DEFAULT_SCAN_SETTINGS } from '../src/scan/types';

// Nov 23 (the owner's real scan): Home Depot's pages were not read, and all 16 bundles became "What is inside the ...?"
// questions. A bundle whose own page was not read waits for it instead (waiting_page); a question is opened only once the
// page is read and the split is still uncertain (rule 4 unchanged). The bundle is the recorded PCL1600K2-P553 (320243741),
// whose page names no models, so even read it stays a question.

const T0 = Date.UTC(2026, 10, 23, 9);
const ITEM = '320243741';
const KEY = bundleKey(ITEM);
const PAGE_TEXT = (JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pages-2026-11-10.json', import.meta.url), 'utf8')) as {
  pages: { itemId: string; text: string }[];
}).pages.find((p) => p.itemId === ITEM)!.text;
const page = () => ({ ...parseBundlePage(PAGE_TEXT, ITEM)!, readAt: T0 });

const record = (over: Partial<BundleRecord> = {}): BundleRecord => ({
  key: KEY, retailer: 'homedepot', itemId: ITEM, title: 'RYOBI ONE+ 18V Cordless 2-Tool Combo Kit with 2-Port Charger', brand: 'RYOBI',
  model: 'PCL1600K2-P553', upc: null, price: 199, regularPrice: 268, percentOff: 26, link: `https://www.homedepot.com/p/${ITEM}`, seenAt: T0,
  split: null, ...over,
});
const known = { stored: new Map(), catalog: new Map() };

describe('a bundle whose page is not read waits for it (waiting_page)', () => {
  it('the agent (waitForPage) opens no question for it; the report says it waits for its page, not for the owner', async () => {
    const store = new MemoryScanStore();
    await store.putBundle(record());
    const { split, opened } = await splitOne(store, record(), known, T0, true);
    expect(split.status).not.toBe('resolved');
    expect(opened).toBe(false);
    expect(await store.getReview(`split:${KEY}`)).toBeUndefined();
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.key === KEY)!;
    expect(row).toMatchObject({ section: 'split', waitingPage: true });
    expect(matchState(row)).toBe(WAITING_PAGE_TEXT);
  });

  it('once its page is read and the split is still uncertain, the question is opened', async () => {
    const store = new MemoryScanStore();
    const withPage = record({ page: page() });
    await store.putBundle(withPage);
    const { opened } = await splitOne(store, withPage, known, T0, true);
    expect(opened).toBe(true);
    expect((await store.getReview(`split:${KEY}`))?.answer).toBeNull();
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.key === KEY)!;
    expect(row.waitingPage).toBeUndefined();
  });

  it('the command line (no wait) asks from the title as before', async () => {
    const store = new MemoryScanStore();
    await store.putBundle(record());
    expect((await splitOne(store, record(), known, T0)).opened).toBe(true);
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.key === KEY)!;
    expect(row.waitingPage).toBeUndefined();
  });

  it('a question opened before for an unread page is withdrawn by the next scan, and asked again when the page is read', async () => {
    const store = new MemoryScanStore();
    await store.putBundle(record());
    await splitOne(store, record(), known, T0);
    await splitOne(store, record(), known, T0 + 1, true);
    expect(await store.getReview(`split:${KEY}`)).toMatchObject({ answer: RESOLVED_BY_SCAN, answeredAt: T0 + 1 });
    expect((await splitOne(store, record({ page: page() }), known, T0 + 2, true)).opened).toBe(true);
    expect((await store.getReview(`split:${KEY}`))?.answer).toBeNull();
  });
});

describe('the migration at the agent start (withdrawUnreadSplitQuestions)', () => {
  it('withdraws open split questions of bundles whose page was never read; keeps answered ones, read pages and match questions', async () => {
    const store = new MemoryScanStore();
    const other = record({ key: bundleKey('317987591'), itemId: '317987591', model: 'PCL1600K2', page: page() });
    const answered = record({ key: bundleKey('324904496'), itemId: '324904496', model: 'PCL1201K2-PCL430B' });
    for (const b of [record(), other, answered]) {
      await store.putBundle(b);
      await splitOne(store, b, known, T0);
    }
    const q = (await store.getReview(`split:${answered.key}`))!;
    await store.putReview({ ...q, answer: 'none', answeredAt: T0 });
    await store.putReview({ ...q, id: 'match:RYOBI:P553', kind: 'match', subject: 'RYOBI:P553', answer: null, answeredAt: null });

    expect(await withdrawUnreadSplitQuestions(store, T0 + 5)).toEqual([`split:${KEY}`]);
    expect(await store.getReview(`split:${KEY}`)).toMatchObject({ answer: RESOLVED_BY_SCAN, answeredAt: T0 + 5 });
    expect((await store.getReview(`split:${other.key}`))?.answer ?? 'none-open').not.toBe(RESOLVED_BY_SCAN);
    expect((await store.getReview(`split:${answered.key}`))?.answer).toBe('none');
    expect((await store.getReview('match:RYOBI:P553'))?.answer).toBeNull();
    // Run again: nothing left to withdraw.
    expect(await withdrawUnreadSplitQuestions(store, T0 + 6)).toEqual([]);
  });
});
