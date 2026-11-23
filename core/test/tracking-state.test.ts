import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_FEES } from '../src/money';
import type { ReviewItem } from '../src/scan/types';
import { DEFAULT_SETTINGS } from '../src/settings';
import { bogoFacetOf, bogoFromBody, bogoView, freeParts, type BogoPromotion } from '../src/tracking/bogo';
import { FBA_FEE_LABEL, fbaEstimateOf } from '../src/tracking/fba';
import { emptyTracking, freshSignals, setWatch, trackReport } from '../src/tracking/state';
import { ASIN, bundle, option, part, recordedTrend } from './tracking-world';

const alerts = { ...DEFAULT_SETTINGS.alerts, enabled: true, minProfit: 20, minRoiPercent: 20 };
const NOW = new Date(2026, 10, 23, 10).getTime();
const good = () => bundle([option('whole', 299, [part('DCF921B', ASIN.DCF921B, 249), part('DCB606', ASIN.DCB606, 199)])]);
const recorded = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/recorded/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;

describe('the watchlist and each scan', () => {
  it('watches a confirmed, discounted bundle by itself, keeps every bundle history, and judges every bundle (signals round 3)', () => {
    const plain = { ...good(), key: 'DEWALT:PLAIN', percentOff: null };
    const s = trackReport(emptyTracking(), { bundles: [good(), plain], review: [] }, recordedTrend, alerts, NOW);
    expect(s.watch).toEqual({ 'DEWALT:DCK200D1P1W921B': { watched: true, by: 'auto', since: NOW } });
    expect(Object.keys(s.history)).toEqual(['DEWALT:DCK200D1P1W921B', 'DEWALT:PLAIN']);
    expect(Object.keys(s.signals)).toEqual(['DEWALT:DCK200D1P1W921B', 'DEWALT:PLAIN']);
    expect(s.signals['DEWALT:DCK200D1P1W921B']!.buyNow?.kind).toBe('buyNow');
    // The unwatched one has its verdict too (the row shows it), but only a watched bundle goes in a digest.
    expect(s.signals['DEWALT:PLAIN']!.verdict).toMatch(/^Worth buying now/);
    expect(freshSignals(s, ['buyNow'], NOW).lines.map((l) => l.bundleKey)).toEqual(['DEWALT:DCK200D1P1W921B']);
  });

  it("the owner's Unwatch holds against the next scan", () => {
    const off = setWatch(emptyTracking(), 'DEWALT:DCK200D1P1W921B', false, NOW);
    const s = trackReport(off, { bundles: [good()], review: [] }, recordedTrend, alerts, NOW);
    expect(s.watch['DEWALT:DCK200D1P1W921B']).toEqual({ watched: false, by: 'owner', since: NOW });
    expect(freshSignals(s, ['buyNow'], NOW).lines).toEqual([]);
  });

  it('a split question on the bundle is an open question in its history point', () => {
    const review = [{ id: 'split:DEWALT:DCK200D1P1W921B', kind: 'split', subject: 'DEWALT:DCK200D1P1W921B', answer: null }] as unknown as ReviewItem[];
    const s = trackReport(emptyTracking(), { bundles: [good()], review }, recordedTrend, alerts, NOW);
    expect(s.history['DEWALT:DCK200D1P1W921B']![0]!.reviewOpen).toBe(true);
  });

  it('a signal is sent once per bundle and day', () => {
    const s = trackReport(emptyTracking(), { bundles: [good()], review: [] }, recordedTrend, alerts, NOW);
    const first = freshSignals(s, ['buyNow'], NOW);
    expect(first.lines.map((l) => l.model)).toEqual(['DCK200D1P1W921B']);
    expect(first.notified).toEqual(['DEWALT:DCK200D1P1W921B|buyNow|2026-11-23']);
    expect(freshSignals({ ...s, notified: first.notified }, ['buyNow'], NOW + 3_600_000).lines).toEqual([]);
    expect(freshSignals({ ...s, notified: first.notified }, ['buyNow'], NOW + 86_400_000).lines).toHaveLength(1);
  });
});

describe('BOGO: the bundle plus the free tool the owner chooses', () => {
  const promo = (chosen: BogoPromotion['chosen'] = []): BogoPromotion => ({
    bundleKey: 'DEWALT:DCK200D1P1W921B', source: 'owner', freeCount: 1, chosen, link: null, at: NOW,
    eligible: [{ brand: 'DEWALT', model: 'DCF921B', title: null, itemId: null, link: null, parts: null }],
  });

  it('reads the one recorded shape: the search\'s "Featured BOGO" filter, not which rows are on it', () => {
    expect(bogoFacetOf(recorded('hd-bundles-dewalt-p1.json'))).toEqual({
      count: 135, token: '1z24hvk', link: 'https://www.homedepot.com/b/Featured-BOGO/N-5yc1vZ1z24hvk/Ntk-elasticplus/Ntt-dewalt%2B20v%2Bcombo%2Bkit?NCNI-5',
    });
    expect(bogoFacetOf(recorded('hd-bundles-ryobi-p1.json'))?.count).toBe(72);
    expect(bogoFacetOf(recorded('hd-product-328814689.json'))).toBeNull();
  });

  it('until the owner chooses: "choose your free tool", the eligible list, and the estimate without it', () => {
    const v = bogoView(promo(), good().options[0], [], DEFAULT_FEES);
    expect(v).toMatchObject({ status: 'choose', label: 'BOGO: choose your free tool', note: '+ free tool not counted yet' });
    expect(v.estimate).toEqual(good().estimate);
    expect(v.eligible?.map((e) => e.model)).toEqual(['DCF921B']);
  });

  it('the chosen free tool adds its net at the same cost', () => {
    const chosen = promo([{ brand: 'DEWALT', model: 'DCF921B', title: null, itemId: null, link: null, parts: null }]);
    expect(freeParts(chosen)).toEqual([{ brand: 'DEWALT', model: 'DCF921B', qty: 1 }]);
    const v = bogoView(chosen, good().options[0], [part('DCF921B', ASIN.DCF921B, 249)], DEFAULT_FEES);
    expect(v.label).toBe('BOGO: DCF921B free');
    expect(v.counted).toEqual([{ model: 'DCF921B', asin: ASIN.DCF921B, qty: 1, price: 249, net: 211.65 }]);
    expect(v.estimate).toEqual({ cost: 299, netRevenue: 592.45, profit: 293.45, roi: 0.9814 });
    expect(v.note).toBeNull();
  });

  it('a free part not looked up yet is not counted, and says so', () => {
    const chosen = promo([{ brand: 'DEWALT', model: 'DCF921B', title: null, itemId: null, link: null, parts: null }]);
    const v = bogoView(chosen, good().options[0], [part('DCF921B', null, null, 1, 'unmatched')], DEFAULT_FEES);
    expect(v.estimate).toEqual(good().estimate);
    expect(v.note).toBe('+ DCF921B not counted yet (not looked up on Amazon yet)');
  });

  it("the owner's entry: a choice must be on the eligible list and within the free count", () => {
    const base = bogoFromBody({ eligible: [{ model: 'dcf921b' }, { model: 'DCB606' }] }, 'K', 'DEWALT', undefined, NOW);
    expect(base).toMatchObject({ freeCount: 1, chosen: [], eligible: [{ brand: 'DEWALT', model: 'DCF921B' }, { model: 'DCB606' }] });
    expect(bogoFromBody({ chosen: [{ model: 'DCS354B' }] }, 'K', 'DEWALT', base as BogoPromotion, NOW)).toBe('DCS354B is not on this promotion\'s eligible list.');
    expect(bogoFromBody({ chosen: [{ model: 'DCF921B' }, { model: 'DCB606' }] }, 'K', 'DEWALT', base as BogoPromotion, NOW)).toBe('Choose at most 1 free item.');
    expect(bogoFromBody({ chosen: [{ model: 'DCB606' }] }, 'K', 'DEWALT', base as BogoPromotion, NOW)).toMatchObject({ chosen: [{ model: 'DCB606', parts: null }] });
  });
});

describe("Amazon's FBA fee estimate (Keepa) per part", () => {
  it('replaces the flat fulfillment setting for the parts Keepa has a fee for, beside the estimate', () => {
    const f = fbaEstimateOf(good().options[0], recordedTrend, DEFAULT_FEES);
    expect(f?.label).toBe(FBA_FEE_LABEL);
    expect(f?.parts).toEqual([
      { model: 'DCF921B', qty: 1, fee: 7.6, source: 'keepa' },
      { model: 'DCB606', qty: 1, fee: 7.1, source: 'keepa' },
    ]);
    expect(f?.estimate).toEqual({ cost: 299, netRevenue: 366.1, profit: 67.1, roi: 0.2244 });
  });

  it('nothing when no counted part has a Keepa fee stored', () => {
    const row = bundle([option('whole', 299, [part('DCB205', 'B0NOTPULLED', 99)])]);
    expect(fbaEstimateOf(row.options[0], recordedTrend, DEFAULT_FEES)).toBeNull();
  });
});
