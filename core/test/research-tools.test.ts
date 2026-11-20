// The recorded tools of the research eval (scripts/research-tools.ts, fix round 1): a search recorded
// word for word answers as Home Depot did; any other search answers from the recorded index, every
// product a recorded search or page shows, ranked by a model number in the query first, then by title
// words. The queries below are the ones the first real run made (runs-claude-opus-5-5.json, Nov 20),
// which no recording held. No network.

import { describe, expect, it } from 'vitest';

import { INDEX_LABEL, recordedTools, replayedTools, searchIndex, type ToolCallLog } from '../../scripts/research-tools';
import { recorded } from './research-world';

const models = (rows: { model: string }[]) => rows.map((r) => r.model);

describe('the recorded index', () => {
  it('holds the products of the Nov 20 searches and pages, the validation pages and the validation part searches, once each', () => {
    const { products } = recorded();
    const ids = products.map((p) => p.itemId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(products.find((p) => p.itemId === '318898528')).toMatchObject({ brand: 'RYOBI', model: 'PCL525B', title: 'ONE+ 18V Cordless Jig Saw (Tool Only)' });
    expect(products.find((p) => p.itemId === '328690510')).toMatchObject({ model: 'PCL500525SB' });
    // From the validation part searches (hd-part-prices-2026-11-18.json) only.
    expect(products.some((p) => p.model === 'PCL430B')).toBe(true);
  });

  it('a model number in the query comes first, in any written form (PCL525 finds PCL525B)', () => {
    const { products } = recorded();
    expect(models(searchIndex(products, 'RYOBI ONE+ 18V Jig Saw Tool Only PCL525B'))[0]).toBe('PCL525B');
    expect(models(searchIndex(products, 'ryobi pcl525 jig saw'))[0]).toBe('PCL525B');
    expect(models(searchIndex(products, 'RYOBI ONE+ 18V 5-1/2 in. Circular Saw Tool Only PCL500B'))[0]).toBe('PCL500B');
    // A longer model is another product: PCL500 does not match PCL500K1 or PCL500B-PCL525B as a model.
    const pcl500 = searchIndex(products, 'PCL500');
    expect(pcl500[0]!.model).toBe('PCL500B');
    expect(pcl500.filter((r) => r.model === 'PCL500K1' || r.model === 'PCL500B-PCL525B').length).toBe(0);
  });

  it('without a model, title words rank; the brand the query names filters; at most 10; nothing for nonsense', () => {
    const { products } = recorded();
    const jig = searchIndex(products, 'RYOBI jig saw tool only');
    expect(jig.length).toBeGreaterThan(0);
    expect(jig.length).toBeLessThanOrEqual(10);
    expect(jig.every((r) => r.brand.toUpperCase() === 'RYOBI')).toBe(true);
    expect(jig.slice(0, 3).every((r) => /jig saw/i.test(r.title))).toBe(true);
    expect(searchIndex(products, 'DEWALT jig saw').every((r) => r.brand.toUpperCase() === 'DEWALT')).toBe(true);
    expect(searchIndex(products, 'qqqq zzzz')).toEqual([]);
  });
});

describe('recordedTools and replayedTools', () => {
  it('a recorded query answers as recorded; another answers from the index, labelled so; every call is logged with its result', async () => {
    const log: ToolCallLog[] = [];
    const tools = recordedTools(recorded(), [], log);
    const exact = await tools.searchHomeDepot({ query: 'Ryobi  PCL500' });
    expect(exact).toMatchObject({ sourceId: 'hd-search:ryobi-pcl500', label: 'Home Depot search' });
    const index = await tools.searchHomeDepot({ query: 'RYOBI PBP003 18V 2.0 Ah Battery' });
    expect(index).toMatchObject({ label: INDEX_LABEL });
    expect('results' in index && index.results[0]!.model).toBe('PBP003');
    expect(await tools.readHomeDepotPage({ itemId: '111111111' })).toEqual({ error: 'not recorded' });
    expect(log.map((l) => l.source)).toEqual(['recorded', 'recorded index', 'not recorded']);
    expect(log.every((l) => l.result !== undefined)).toBe(true);

    // A replay gives back the same results, call by call; a call off the log is not recorded.
    const again = replayedTools(log);
    expect(await again.searchHomeDepot({ query: 'anything' })).toEqual(exact);
    expect(await again.readHomeDepotPage({ itemId: '328690510' })).toEqual({ error: 'not recorded' });
  });

  it('reads a page as the extension does (parsePageState): its descriptive bullets and specifications', async () => {
    const page = await recordedTools(recorded(), []).readHomeDepotPage({ url: 'https://www.homedepot.com/p/RYOBI-ONE-18V/328690510' });
    if ('error' in page) throw new Error(page.error);
    expect(page.sections.bullets).toContain('Includes: 18V 5-1/2" Circular Saw, 18V Jig Saw, 18T Carbide Tipped Blade, (2) Hex Wrenches, Non-Marring Shoe, T-Shank Wood Cutting Blade, and Operator\'s Manuals');
    expect(page.sections.specifications).toContainEqual({ name: 'Number of Tools (Bonus Tool Not Included)', value: '2' });
    expect(page.url).toBe('https://www.homedepot.com/p/328690510');
  });
});
