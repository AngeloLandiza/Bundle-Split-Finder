import { describe, expect, it } from 'vitest';
import { DEALS } from '../api/mockData';
import type { DealRow } from '../api/types';
import { DEAL_VIEWS, VIEW_LABEL, inView, viewCounts } from './views';

const row = (model: string): DealRow => {
  const r = DEALS.find((d) => d.model === model);
  if (!r) throw new Error(`no mock row ${model}`);
  return r;
};

describe('deal views', () => {
  it('puts a bundle that waits for an answer under Needs an answer, never under Confirmed or Losing money', () => {
    const r = row('PCL1600K2'); // a confirmed kit with one open question (the PCL660B listing)
    expect(inView(r, 'needs-answer')).toBe(true);
    expect(inView(r, 'confirmed')).toBe(false);
    expect(inView(r, 'losing')).toBe(false);
  });
  it('puts a bundle with parts still to look up under Waiting for data', () => {
    expect(inView(row('PCL1600K2-P553'), 'waiting')).toBe(true);
    expect(inView(row('PCL1200K2'), 'waiting')).toBe(false);
  });
  it('puts a bundle waiting for its Home Depot page under Waiting for data, never under Needs an answer', () => {
    const r: DealRow = { ...row('PCL1600K2'), needsAnswer: false, matchKind: 'waiting_page', profit: null };
    expect(inView(r, 'waiting')).toBe(true);
    expect(inView(r, 'needs-answer')).toBe(false);
    expect(inView(r, 'confirmed')).toBe(false);
  });
  it('counts Losing money only from an estimate below zero', () => {
    const loss = { ...row('PCL1200K2'), profit: -12.5 };
    expect(inView(loss, 'losing')).toBe(true);
    expect(inView({ ...loss, profit: null }, 'losing')).toBe(false);
  });
  it('Nov 23: a bundle missing a price is under Missing a price, never under Losing money, whatever its break-even', () => {
    // DCK200D1P1W921B after the owner's third scan: before, "-$158.75 est." in Losing money, the kit counted at $0.
    const incomplete = { priced: 1, total: 2, pricedNet: 140.25, breakEvenNet: 158.75, breakEvenPrice: 186.76, unpriced: ['DCK200D1P1'] };
    const missing: DealRow = { ...row('PCL1200K2'), profit: null, roi: null, incomplete };
    expect(inView(missing, 'missing-price')).toBe(true);
    expect(inView(missing, 'losing')).toBe(false);
    expect(inView({ ...missing, needsAnswer: true }, 'missing-price')).toBe(true);
    // A complete estimate below zero is a loss and is not missing a price.
    const loss: DealRow = { ...row('PCL1200K2'), profit: -0.94, incomplete: null };
    expect(inView(loss, 'losing')).toBe(true);
    expect(inView(loss, 'missing-price')).toBe(false);
    expect(VIEW_LABEL['missing-price']).toBe('Missing a price');
    expect(DEAL_VIEWS.indexOf('missing-price')).toBe(DEAL_VIEWS.indexOf('losing') - 1);
  });
  it('counts every row under All', () => {
    expect(viewCounts(DEALS).all).toBe(DEALS.length);
  });
  it('puts a bundle under Worth buying now only when the last scan said so, and under Watchlist when it is watched', () => {
    const now = row('DCK240C2'); // watched, and the last scan judged it worth buying now
    expect(now.buyNow).toBe(true);
    expect(inView(now, 'buy-now')).toBe(true);
    expect(inView(now, 'watchlist')).toBe(true);
    const owned = row('PCL1200K2'); // watched, but it leaves a charger unsold
    expect(inView(owned, 'watchlist')).toBe(true);
    expect(inView(owned, 'buy-now')).toBe(false);
    const plain = row('PCL1600K2-P553');
    expect(inView(plain, 'watchlist')).toBe(false);
    expect(inView({ ...plain, watched: false, buyNow: true }, 'buy-now')).toBe(true);
  });
  it('counts the two tracking views from the rows', () => {
    const c = viewCounts(DEALS);
    expect(c['buy-now']).toBe(DEALS.filter((r) => r.buyNow).length);
    expect(c.watchlist).toBe(DEALS.filter((r) => r.watched).length);
    expect(c['buy-now']).toBeGreaterThan(0);
  });
  it('lists Worth buying now first and the Watchlist last, each with a label', () => {
    expect(DEAL_VIEWS[0]).toBe('buy-now');
    expect(DEAL_VIEWS.at(-1)).toBe('watchlist');
    expect(VIEW_LABEL['buy-now']).toBe('Worth buying now');
    expect(VIEW_LABEL.watchlist).toBe('Watchlist');
  });
});
