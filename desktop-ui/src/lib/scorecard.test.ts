// Today's scorecard, empty and filled, on the owner's real third scan (mockReal.json, from fixtures/e2e-2026-11-23): real deals, listings
// and estimates; the purchases are recorded through the same pure logic the agent runs. No network.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type * as C from '@core/api/contract';
import { DEFAULT_FEES } from '@core/money';
import { applyPartOutcome, newPurchase, scorecardOf, snapshotOf, viewOf } from '@core/outcomes/outcomes';
import type { BundleRow } from '@core/scan/types';
import { mapRow } from '../api/map';
import real from '../api/mockReal.json';
import { ScorecardRows } from '../components/Scorecard';
import { diffWords, EMPTY_SCORECARD, scorecard, signedPercent, type ScorecardInputs } from './scorecard';

const scan3 = real.scan3 as unknown as { deals: { rows: C.DealRow[] }; details: Record<string, { bundle: BundleRow; estimate: { basis: string } }> };
const rows = scan3.deals.rows.map(mapRow);
const PAIR = scan3.details['homedepot:337486530']!;
const NOW = new Date(2026, 10, 26, 12).getTime();
const day = (iso: string) => new Date(`${iso}T12:00:00`).getTime();

const bought = (key = 'homedepot:337486530', buyNow = false) =>
  newPurchase({
    id: `pur-${key.slice(-4)}`, dealId: key, now: day('2026-11-23'),
    snapshot: snapshotOf(scan3.details[key]!.bundle, { fees: DEFAULT_FEES, basis: scan3.details[key]!.estimate.basis, buyNow, at: new Date(day('2026-11-23')).toISOString() }),
  });
const response = (purchases: ReturnType<typeof bought>[], now = NOW): C.OutcomesResponse => ({ purchases: purchases.map(viewOf), scorecard: scorecardOf(purchases, now), entries: [] });
const inputs = (purchases: ReturnType<typeof bought>[], over: Partial<ScorecardInputs> = {}): ScorecardInputs => ({
  outcomes: response(purchases), rows, questions: { open: 10, working: 2 }, month: { searches: 16, aiUsd: 0.13 }, aiCapUsd: 25, ...over,
});

describe('the scorecard with no purchases', () => {
  const card = scorecard(inputs([]));
  it('says so and what to do, and shows no dollar figure for what was never recorded', () => {
    expect(card.recorded).toEqual({ kind: 'empty', title: 'No purchases recorded yet', cause: EMPTY_SCORECARD.cause });
    expect(EMPTY_SCORECARD.cause).toMatch(/press I bought this/);
    const html = renderToStaticMarkup(createElement(ScorecardRows, { card }));
    expect(html).toContain('No purchases recorded yet');
    expect(html).not.toMatch(/\$0(\.00)?(?![\d.])/);
    expect(html).not.toContain('Profit realised');
  });
  it('still reports what the app itself recorded: open questions, complete estimates, the month\'s cost', () => {
    expect(card.details.map((l) => [l.id, l.value])).toEqual([
      ['questions', '10'],
      ['complete', '13 of 59 (22%)'],
      ['cost', '16 searches · $0.13 AI'],
    ]);
    expect(card.details[0]!.sub).toEqual(['2 more are being checked by the app.']);
  });
  it('says what is not known yet instead of a number while the lists load', () => {
    expect(scorecard(inputs([], { rows: null, questions: null, month: null })).details).toEqual([]);
    expect(scorecard(inputs([], { rows: [] })).details.find((l) => l.id === 'complete')!.value).toBe('No bundles found yet');
  });
});

describe('the scorecard with purchases', () => {
  it('a purchase with nothing sold yet says nothing was realised, not $0', () => {
    const card = scorecard(inputs([bought()]));
    const [realised, accuracy, flagged] = card.recorded.kind === 'lines' ? card.recorded.lines : [];
    expect(realised).toMatchObject({ label: 'Profit realised in November', value: 'Nothing sold yet in November' });
    expect(accuracy).toMatchObject({ value: 'No completed deal yet' });
    expect(flagged!.value).toBe(`${rows.filter((r) => r.buyNow).length} flagged now · 1 bought`);
    expect(JSON.stringify(card)).not.toContain('$0.00');
  });

  it('a partial sale shows N of M parts and the profit realised on the sold part, labelled as recorded', () => {
    const p = applyPartOutcome(bought(), 'p0', { status: 'sold', salePrice: 150, date: '2026-11-25' }, day('2026-11-25'));
    const card = scorecard(inputs([p]));
    const realised = card.recorded.kind === 'lines' ? card.recorded.lines[0]! : null;
    expect(realised).toMatchObject({ value: '+$0.92' }); // $127.50 net less its $126.58 share of the $179 paid (131.27 of 185.63 estimated net)
    expect(realised!.sub[0]).toBe('1 of 2 parts sold');
    expect(realised!.sub.join(' ')).toMatch(/Recorded by you/);
    expect(realised!.sub.join(' ')).toMatch(/fees estimated/);
  });

  it('a completed deal compares what was made with the estimate, in dollars and percent, per deal and overall', () => {
    let p = applyPartOutcome(bought(), 'p0', { status: 'sold', salePrice: 150, netPayout: 120, date: '2026-11-25' }, day('2026-11-25'));
    p = applyPartOutcome(p, 'p1', { status: 'sold', salePrice: 60, netPayout: 50, date: '2026-11-26' }, day('2026-11-26'));
    const card = scorecard(inputs([p]));
    const lines = card.recorded.kind === 'lines' ? card.recorded.lines : [];
    expect(lines[0]).toMatchObject({ value: '−$9.00' });
    expect(lines[0]!.sub[0]).toBe('All 2 parts sold or returned');
    expect(lines[1]).toMatchObject({ label: 'Estimate accuracy', value: '$15.63 below the estimate (−235.7%)' });
    expect(lines[1]!.sub[0]).toBe('1 completed deal: made −$9.00 (recorded by you) against +$6.63 estimated.');
    expect(card.details[0]).toMatchObject({ value: '$15.63 below the estimate (−235.7%)', sub: ['Made −$9.00 (recorded) against +$6.63 estimated.'] });
  });

  it('counts the deals flagged Buy now when bought against the ones bought', () => {
    const card = scorecard(inputs([bought('homedepot:337486530', true), bought('homedepot:337504846', false)]));
    const flagged = card.recorded.kind === 'lines' ? card.recorded.lines[2]! : null;
    expect(flagged!.sub).toEqual(['1 of the 2 bought were flagged Buy now when you bought them.']);
  });

  it('draws as rows with the detail behind one disclosure, and never says a recorded figure is an estimate or the reverse', () => {
    let p = applyPartOutcome(bought(), 'p0', { status: 'sold', salePrice: 150, netPayout: 120, date: '2026-11-25' }, day('2026-11-25'));
    p = applyPartOutcome(p, 'p1', { status: 'sold', salePrice: 60, netPayout: 50, date: '2026-11-26' }, day('2026-11-26'));
    const html = renderToStaticMarkup(createElement(ScorecardRows, { card: scorecard(inputs([p])) }));
    expect(html).toContain('Profit realised in November');
    expect(html).toContain('Estimate accuracy');
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).toContain('More detail');
    expect(html).toContain('recorded by you');
    expect(html).toContain('Open questions now');
    expect(html).toContain('Running cost, November');
  });
});

describe('the words', () => {
  it('signs percents with the real minus and keeps one decimal only when it is not whole', () => {
    expect(signedPercent(-235.7)).toBe('−235.7%');
    expect(signedPercent(12)).toBe('+12%');
    expect(signedPercent(0)).toBe('0%');
  });
  it('says on the estimate when the difference is under a cent, and drops the percent against an estimate of zero', () => {
    expect(diffWords(0.004, 0.1)).toBe('Exactly on the estimate');
    expect(diffWords(5, null)).toBe('$5.00 above the estimate');
  });
});
