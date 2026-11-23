import { describe, expect, it } from 'vitest';
import { DEALS } from '../api/mockData';
import type { DealRow } from '../api/types';
import { inView, viewCounts } from './views';

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
  it('puts a bundle with parts still to look up under Waiting for a lookup', () => {
    expect(inView(row('PCL1600K2-P553'), 'waiting')).toBe(true);
    expect(inView(row('PCL1200K2'), 'waiting')).toBe(false);
  });
  it('counts Losing money only from an estimate below zero', () => {
    const loss = { ...row('PCL1200K2'), profit: -12.5 };
    expect(inView(loss, 'losing')).toBe(true);
    expect(inView({ ...loss, profit: null }, 'losing')).toBe(false);
  });
  it('counts every row under All', () => {
    expect(viewCounts(DEALS).all).toBe(DEALS.length);
  });
});
