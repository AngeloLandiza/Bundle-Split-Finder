import { describe, expect, it } from 'vitest';
import { ariaSort, nextSort, sortRows } from './sort';

type Row = { id: string; profit: number | null; title: string };
const rows: Row[] = [
  { id: 'a', profit: 64.1, title: 'DCK240C2' },
  { id: 'b', profit: null, title: 'PCL1600K2' },
  { id: 'c', profit: -12.5, title: 'DCK225D2' },
  { id: 'd', profit: 118.4, title: 'DCKTS681D1P1' },
  { id: 'e', profit: 64.1, title: 'PCL1200K2' },
];
const value = (r: Row, k: 'profit' | 'title') => r[k];
const ids = (xs: Row[]) => xs.map((r) => r.id).join('');

describe('sortRows', () => {
  it('sorts figures high to low and keeps rows with no figure last', () => {
    expect(ids(sortRows(rows, { key: 'profit', dir: 'desc' }, value))).toBe('daecb');
  });
  it('keeps no-figure rows last when ascending too', () => {
    expect(ids(sortRows(rows, { key: 'profit', dir: 'asc' }, value))).toBe('caedb');
  });
  it('keeps the incoming order for ties', () => {
    const sorted = sortRows(rows, { key: 'profit', dir: 'desc' }, value);
    expect(sorted.indexOf(rows[0]!)).toBeLessThan(sorted.indexOf(rows[4]!));
  });
  it('sorts words A to Z', () => {
    expect(ids(sortRows(rows, { key: 'title', dir: 'asc' }, value))).toBe('cadeb');
  });
});

describe('nextSort', () => {
  it('flips the same column and starts a new one at its natural direction', () => {
    expect(nextSort({ key: 'profit', dir: 'desc' }, 'profit', 'desc')).toEqual({ key: 'profit', dir: 'asc' });
    expect(nextSort({ key: 'profit', dir: 'asc' }, 'title', 'asc')).toEqual({ key: 'title', dir: 'asc' });
  });
  it('reports aria-sort only on the sorted head', () => {
    expect(ariaSort({ key: 'profit', dir: 'desc' }, 'profit')).toBe('descending');
    expect(ariaSort({ key: 'profit', dir: 'desc' }, 'title')).toBe('none');
  });
});
