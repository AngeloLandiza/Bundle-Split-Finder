import { describe, expect, it } from 'vitest';

import { bundlesCsv, RUN_COLUMNS } from '../src/scan/csv';
import { answeredKitWorld, KIT_KEY, kitReport, kitRunPaid, P553_KEY } from './kit-world';

// The ways to sell of a bundle that holds a kit, in the run file. Replayed data; nothing reaches the network.

// The four columns of step 9 follow other_options; these tests are about the two before them, so the line is cut
// before them (their cells are numbers or empty, never a comma).
const lineOf = (csv: string): string[] => csv.trimEnd().split('\n').map((l, i) => (i === 0 ? l : l.split(',').slice(0, -9).join(',')));

describe('CSV: sold_as and other_options', () => {
  it('ends the header with the two columns', () => {
    expect(RUN_COLUMNS.slice(-12, -9)).toEqual(['hd_link', 'sold_as', 'other_options']);
  });

  it('writes the primary label and, while no option has an estimate, an empty other_options', async () => {
    const w = await answeredKitWorld();
    const row = (await kitReport(w)).bundles.find((b) => b.key === P553_KEY)!;
    expect(row.options.map((o) => o.estimate)).toEqual([null, null]);
    const cells = lineOf(bundlesCsv([row]))[1]!;
    expect(cells.endsWith(',PCL1600K2 sold whole,')).toBe(true);
  });

  it('writes the other options as "label: est_profit" once they have one', async () => {
    const w = await answeredKitWorld();
    expect(await kitRunPaid(w, { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PCL1600K2' }, { brand: 'RYOBI', model: 'P553' }] })).toBeNull();
    const row = (await kitReport(w)).bundles.find((b) => b.key === P553_KEY)!;
    const [primary, other] = row.options;
    // Nov 23: the kit has no listing and P553 is in Review: no price, so neither option has an estimate, and none is invented.
    expect(primary!.estimate).toBeNull();
    expect(other!.estimate).toBeNull();
    expect(lineOf(bundlesCsv([row]))[1]!.endsWith(`,${primary!.label},`)).toBe(true);
    // Hand both options an estimate to check the pair format on a real row.
    const est = { cost: 388, netRevenue: 400, profit: 12, roi: 0.0309 };
    const withBoth = { ...row, options: [{ ...primary!, estimate: est }, { ...other!, estimate: est }] };
    const csv = lineOf(bundlesCsv([withBoth]))[1]!;
    expect(csv.endsWith(`,${primary!.label},${other!.label}: 12`)).toBe(true);
  });

  it('leaves both empty for a bundle with one way to sell, and for the one with no options', async () => {
    const w = await answeredKitWorld('none');
    const row = (await kitReport(w)).bundles.find((b) => b.key === P553_KEY)!;
    expect(row.options).toEqual([]);
    const [header, cells] = lineOf(bundlesCsv([row]));
    expect(header!.includes(',sold_as,other_options,roi_lowest,')).toBe(true);
    expect(cells!.endsWith(',,')).toBe(true);
    const kit = (await kitReport(w)).bundles.find((b) => b.key === KIT_KEY)!;
    expect(kit.options.length).toBeGreaterThan(0);
  });
});
