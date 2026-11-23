import { describe, expect, it } from 'vitest';
import { DETAILS } from '../api/mockData';
import type { DealHistoryPoint } from '../api/types';
import { chartKinds, chartOf, extent, isolated, linePath, nearestScan, niceScale, niceStep, readout, sorted } from './chart';

const point = (at: string, o: Partial<DealHistoryPoint> = {}): DealHistoryPoint => ({ at, section: 'confirmed', price: 149, amazonNew: 246, profit: 38.1, roiPercent: 25.6, monthlySold: 90, salesRank: null, offers: 6, ...o });
const history = (model: string): DealHistoryPoint[] => Object.values(DETAILS).find((d) => d.model === model)!.history;

describe('which charts the history can draw', () => {
  it('draws none from one scan, and says nothing it has no figure for', () => {
    expect(chartKinds([point('2026-11-22T10:00:00Z')])).toEqual([]);
    expect(chartKinds([])).toEqual([]);
  });
  it('draws prices and profit from two scans, sold only when two scans have a figure, and rank only with ranks', () => {
    const two = [point('2026-11-22T10:00:00Z', { monthlySold: null }), point('2026-11-22T22:00:00Z')];
    expect(chartKinds(two)).toEqual(['prices', 'profit']);
    expect(chartKinds([...two, point('2026-11-23T10:00:00Z')])).toEqual(['prices', 'profit', 'sold']);
    expect(chartKinds(two.map((p) => ({ ...p, salesRank: 18_400 })))).toEqual(['prices', 'profit', 'rank']);
  });
  it('reads the mock bundle that has ranks as having all four', () => {
    expect(chartKinds(history('PCL1200K2'))).toEqual(['prices', 'profit', 'sold', 'rank']);
    expect(chartKinds(history('DCK225D2')).includes('rank')).toBe(false);
  });
});

describe('the series', () => {
  it('puts what he pays and what the parts sell for in the prices chart, in scan order even if the points arrive shuffled', () => {
    const pts = [point('2026-11-23T10:00:00Z', { price: 140 }), point('2026-11-22T10:00:00Z', { price: 149 })];
    expect(sorted(pts).map((p) => p.price)).toEqual([149, 140]);
    const c = chartOf(pts, 'prices');
    expect(c.series.map((s) => s.label)).toEqual(['You pay at Home Depot', 'Amazon New, counted parts']);
    expect(c.series[0]!.values).toEqual([149, 140]);
  });
  it('labels profit as an estimate and writes a loss with a real minus', () => {
    const c = chartOf([point('2026-11-22T10:00:00Z', { profit: -20.7 }), point('2026-11-23T10:00:00Z')], 'profit');
    expect(c.note).toMatch(/estimate/i);
    expect(c.format(-20.7)).toBe('−$20.70');
    expect(c.axis(-20.7)).toBe('−$21');
    expect(c.format(38.1)).toBe('+$38.10');
  });
  it('reads a gap as "no figure", never as a number', () => {
    const c = chartOf([point('2026-11-22T10:00:00Z', { monthlySold: null }), point('2026-11-23T10:00:00Z', { monthlySold: 90 })], 'sold');
    expect(readout(c, 0)).toMatch(/no figure$/);
    expect(readout(c, 1)).toMatch(/90 a month$/);
  });
});

describe('scales and lines', () => {
  it('rounds the axis to steps of 1, 2, 2.5 or 5 and keeps the data inside', () => {
    expect(niceStep(100, 4)).toBe(25);
    expect(niceStep(7, 3)).toBe(2.5);
    const s = niceScale(38.1, 112.4);
    expect(s.min).toBeLessThanOrEqual(38.1);
    expect(s.max).toBeGreaterThanOrEqual(112.4);
    expect(s.ticks.at(0)).toBe(s.min);
    expect(s.ticks.at(-1)).toBe(s.max);
  });
  it('gives a flat series a span instead of dividing by zero', () => {
    const s = niceScale(90, 90);
    expect(s.max).toBeGreaterThan(s.min);
    expect(s.ticks.length).toBeGreaterThan(1);
  });
  it('breaks the line where a scan had no figure and marks a lone figure as a dot', () => {
    const x = (i: number) => i * 10;
    const y = (v: number) => 100 - v;
    expect(linePath([10, 20, null, 30, 40], x, y)).toBe('M0.0 90.0L10.0 80.0M30.0 70.0L40.0 60.0');
    expect(linePath([null, null], x, y)).toBe('');
    expect(isolated([10, null, 30, null, null, 50, 60])).toEqual([0, 2]);
  });
  it('finds the extent across series and none when there is no figure', () => {
    expect(extent([{ key: 'a', label: 'a', short: 'a', tone: 'ink', values: [5, null, 9] }, { key: 'b', label: 'b', short: 'b', tone: 'accent', values: [2, 4, null] }])).toEqual([2, 9]);
    expect(extent([{ key: 'a', label: 'a', short: 'a', tone: 'ink', values: [null] }])).toBeNull();
  });
  it('picks the scan nearest the pointer, clamped to the ends', () => {
    const t = [0, 10, 30, 100];
    expect(nearestScan(t, 0)).toBe(0);
    expect(nearestScan(t, 0.12)).toBe(1);
    expect(nearestScan(t, 0.25)).toBe(2);
    expect(nearestScan(t, 5)).toBe(3);
    expect(nearestScan(t, -1)).toBe(0);
    expect(nearestScan([], 0.5)).toBe(-1);
  });
});
