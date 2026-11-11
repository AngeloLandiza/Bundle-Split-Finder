import { describe, expect, it } from 'vitest';

import { bundlesCsv, RUN_COLUMNS } from '../src/scan/csv';
import { answeredKitWorld, KIT_KEY, kitReport, kitRunPaid, P553_KEY } from './kit-world';

// The ways to sell of a bundle that holds a kit, in the run file. Replayed data; nothing reaches the network.

const lineOf = (csv: string): string[] => csv.trimEnd().split('\n');

describe('CSV: sold_as and other_options', () => {
  it('ends the header with the two columns', () => {
    expect(RUN_COLUMNS.slice(-3)).toEqual(['hd_link', 'sold_as', 'other_options']);
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
    expect(primary!.estimate).not.toBeNull();
    expect(other!.estimate).toBeNull();
    // The split still waits for its items: no figure is invented for it.
    expect(lineOf(bundlesCsv([row]))[1]!.endsWith(`,${primary!.label},`)).toBe(true);
    // Hand the other option an estimate to check the pair format on a real row.
    const withBoth = { ...row, options: [primary!, { ...other!, estimate: primary!.estimate }] };
    const csv = lineOf(bundlesCsv([withBoth]))[1]!;
    expect(csv.endsWith(`,${primary!.label},${other!.label}: ${primary!.estimate!.profit}`)).toBe(true);
  });

  it('leaves both empty for a bundle with one way to sell, and for the one with no options', async () => {
    const w = await answeredKitWorld('none');
    const row = (await kitReport(w)).bundles.find((b) => b.key === P553_KEY)!;
    expect(row.options).toEqual([]);
    const [header, cells] = lineOf(bundlesCsv([row]));
    expect(header!.endsWith(',sold_as,other_options')).toBe(true);
    expect(cells!.endsWith(',,')).toBe(true);
    const kit = (await kitReport(w)).bundles.find((b) => b.key === KIT_KEY)!;
    expect(kit.options.length).toBeGreaterThan(0);
  });
});
