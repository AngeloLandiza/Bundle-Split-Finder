// Research fix round 3 (whole-step code review): a word-only Includes item ("18V Jig Saw") is not accounted for
// by any model of that kind. When the ledger holds more than one RYOBI jig saw that could fill it, the chosen one
// must be tied to the bundle: the bundle's own page names it, or a listing of the same bundle (same tool count,
// same named tools, same "Tools Only") whose model number lists it is quoted (Home Depot's sibling
// "PCL500B-PCL525B", item 324616618). And a combo of tools is one part only when the catalog knows it as a kit
// (risk 7). Real data throughout: the PCL500525SB ledger of research-world.ts, recorded Nov 18 and Nov 20.

import { describe, expect, it } from 'vitest';

import { bundleIdentity, ledgerFromEvidence, pageEntry, searchEntry } from '../src/research/ledger';
import type { ResearchAnswer, ResearchLedgerEntry, ResearchPart } from '../src/research/types';
import { verifyResearch } from '../src/research/verify';
import { recordedTools } from '../../scripts/research-tools';
import { pcl500525sbLedger, recorded, researchCase, rowLine } from './research-world';

const SIBLING = 'PCL500B-PCL525B';
const INCLUDES = 'Includes: 18V 5-1/2" Circular Saw, 18V Jig Saw, 18T Carbide Tipped Blade, (2) Hex Wrenches, Non-Marring Shoe, T-Shank Wood Cutting Blade';

function parts(ledger: ResearchLedgerEntry[], jig = 'PCL525B', tie = true): ResearchPart[] {
  const sibling = tie ? [{ quote: rowLine(ledger, 'hd-search:1', SIBLING), sourceId: 'hd-search:1' }] : [];
  return [
    { model: 'PCL500B', qty: 1, quotes: [
      { quote: rowLine(ledger, 'hd-search:1', 'PCL500B'), sourceId: 'hd-search:1' }, { quote: '18V 5-1/2" Circular Saw', sourceId: 'bundle' },
      { quote: '18V ONE+ 5-1/2 in. Circular Saw', sourceId: 'hd-page:328690510' },
      { quote: '18T Carbide Tipped Blade', sourceId: 'bundle' }, { quote: '(2) Hex Wrenches', sourceId: 'bundle' }, ...sibling,
    ] },
    { model: jig, qty: 1, quotes: [
      { quote: rowLine(ledger, 'hd-search:2', jig), sourceId: 'hd-search:2' }, { quote: '18V Jig Saw', sourceId: 'bundle' },
      { quote: '18V ONE+ Jig Saw', sourceId: 'hd-page:328690510' },
      { quote: 'Non-Marring Shoe', sourceId: 'bundle' }, { quote: 'T-Shank Wood Cutting Blade', sourceId: 'bundle' }, ...sibling,
    ] },
  ];
}

const answer = (p: ResearchPart[]): ResearchAnswer => ({ quotes: [], parts: p, reason: 'x', decision: 'parts', choiceIndex: null });
const reasonsOf = (r: ReturnType<typeof verifyResearch>): string[] => (r.status === 'unverified' ? r.reasons : []);

describe('a word-only Includes item needs its model tied to the bundle', () => {
  for (const jig of ['PBLJS01B', 'PSBJS01B']) {
    it(`another RYOBI jig saw (${jig}) for "18V Jig Saw" is unverified, with or without the sibling quote`, async () => {
      const { ledger, q, catalog } = await pcl500525sbLedger();
      for (const tie of [false, true]) {
        const r = verifyResearch(answer(parts(ledger, jig, tie)), q, ledger, catalog);
        expect(r.status).toBe('unverified');
        expect(reasonsOf(r)).toContain(`Several RYOBI jig saws fit "18V Jig Saw"; nothing ties ${jig} to this bundle.`);
        // Its own title says brushless; the bundle's page says "Motor Type: Brushed".
        expect(reasonsOf(r)).toContain(`The bundle's page says "Motor Type: Brushed"; ${jig} is brushless.`);
      }
    });
  }

  it('PCL500B + PCL525B verify with the sibling listing quoted, and not without it', async () => {
    const { ledger, q, catalog } = await pcl500525sbLedger();
    expect(rowLine(ledger, 'hd-search:1', SIBLING)).toBe('RYOBI PCL500B-PCL525B (item 324616618): ONE+ 18V Cordless 2-Tool Combo Kit with 5 1/2 in. Circular Saw and Jig Saw (Tools Only)');
    const tied = verifyResearch(answer(parts(ledger)), q, ledger, catalog);
    expect(reasonsOf(tied)).toEqual([]);
    expect(tied).toMatchObject({ status: 'verified', answer: { parts: ['PCL500B', 'PCL525B'] } });
    expect(reasonsOf(verifyResearch(answer(parts(ledger, 'PCL525B', false)), q, ledger, catalog))).toEqual([
      'Several RYOBI circular saws fit "18V 5-1/2" Circular Saw"; nothing ties PCL500B to this bundle.',
      'Several RYOBI circular saws fit "18V ONE+ 5-1/2 in. Circular Saw"; nothing ties PCL500B to this bundle.',
      'Several RYOBI jig saws fit "18V Jig Saw"; nothing ties PCL525B to this bundle.',
      'Several RYOBI jig saws fit "18V ONE+ Jig Saw"; nothing ties PCL525B to this bundle.',
      '"18V 5-1/2" Circular Saw" on the bundle\'s Includes list is left over: no part accounts for it.',
      '"18V Jig Saw" on the bundle\'s Includes list is left over: no part accounts for it.',
      // The page's highlight, "Includes: 18V ONE+ 5-1/2 in. Circular Saw and 18V ONE+ Jig Saw", is two items too.
      '"18V ONE+ 5-1/2 in. Circular Saw" on the bundle\'s Includes list is left over: no part accounts for it.',
      '"18V ONE+ Jig Saw" on the bundle\'s Includes list is left over: no part accounts for it.',
    ]);
  });

  it('a listing of another bundle that names the part is no tie ("PCL500B-PBP006: Circular Saw with 2.0 Ah Battery")', async () => {
    const { ledger, q, catalog } = await pcl500525sbLedger();
    const p = parts(ledger, 'PCL525B', false);
    p[0]!.quotes.push({ quote: rowLine(ledger, 'hd-search:1', 'PCL500B-PBP006'), sourceId: 'hd-search:1' });
    expect(reasonsOf(verifyResearch(answer(p), q, ledger, catalog))).toContain('Several RYOBI circular saws fit "18V 5-1/2" Circular Saw"; nothing ties PCL500B to this bundle.');
  });

  it("the sibling's own page, naming the part among its Includes, ties it too", async () => {
    const { ledger, q, catalog } = await pcl500525sbLedger();
    const page = recorded().pages.get('324616618')!;
    const withPage = [...ledger, pageEntry('hd-page:324616618', page, bundleIdentity(q), '324616618')];
    const line = withPage.at(-1)!.lines.find((l) => l.text.startsWith('Includes:'))!.text;
    const p = parts(ledger, 'PCL525B', false).map((x) => ({ ...x, quotes: [...x.quotes, { quote: line, sourceId: 'hd-page:324616618' }] }));
    expect(reasonsOf(verifyResearch(answer(p), q, withPage, catalog))).toEqual([]);
  });

  it('with only one jig saw of the brand in the ledger (searched by its model number, as run 3 did), the tie is still asked for', async () => {
    const { ledger, q, catalog } = await pcl500525sbLedger();
    // The searches hold several jig saws; keep PCL525B's row and the rows that are not jig saws (and the circular saws, tied by the sibling).
    const keep = (model: string | undefined, text: string) => !/jig saw/i.test(text) || ['PCL525B', SIBLING, 'PCL500525SB'].includes(model ?? '');
    const one = ledger.map((e) => (e.kind === 'homedepot_search'
      ? { ...e, lines: e.lines.filter((l) => keep(l.model, l.text)), products: e.products.filter((x) => keep(x.model, x.title)) } : e));
    const p = parts(one, 'PCL525B', false);
    p[0]!.quotes.push({ quote: rowLine(one, 'hd-search:1', SIBLING), sourceId: 'hd-search:1' });
    expect(reasonsOf(verifyResearch(answer(p), q, one, catalog))).toContain(
      '"18V Jig Saw" names no model, and nothing ties PCL525B to this bundle: neither the bundle\'s page nor a listing of this same bundle that is quoted names it.',
    );
    // The sibling quoted under PCL525B too ties it.
    p[1]!.quotes.push({ quote: rowLine(one, 'hd-search:1', SIBLING), sourceId: 'hd-search:1' });
    expect(reasonsOf(verifyResearch(answer(p), q, one, catalog))).toEqual([]);
  });
});

describe('a combo of tools is one part only when the catalog knows it as a kit (risk 7)', () => {
  it('341644987: PCL500525SB, whose page names its tools in words only, is not one part of PCL500525SB-PBP003', async () => {
    const { q, evidence, catalog } = await researchCase('split:homedepot:341644987');
    const tools = recordedTools(recorded(), catalog);
    const combo = await tools.searchHomeDepot({ query: 'RYOBI PCL500525SB' });
    const battery = await tools.searchHomeDepot({ query: 'RYOBI PBP003' });
    if ('error' in combo || 'error' in battery) throw new Error('no index answer');
    const ledger = [...ledgerFromEvidence(evidence), searchEntry('hd-search:1', combo), searchEntry('hd-search:2', battery)];
    const p: ResearchPart[] = [
      { model: 'PCL500525SB', qty: 1, quotes: [{ quote: rowLine(ledger, 'hd-search:1', 'PCL500525SB'), sourceId: 'hd-search:1' }, { quote: INCLUDES, sourceId: 'bundle' }] },
      { model: 'PBP003', qty: 1, quotes: [{ quote: rowLine(ledger, 'hd-search:2', 'PBP003'), sourceId: 'hd-search:2' }] },
    ];
    expect(reasonsOf(verifyResearch(answer(p), q, ledger, catalog))).toContain('PCL500525SB is a combo of 2 tools that the catalog does not know as a kit; give its tools as the parts.');
  });

  it("Home Depot's combo SKU PCL500B-PCL525B is not one part: a combo, and its page names PCL500 and PCL525", async () => {
    const { ledger, q, catalog } = await pcl500525sbLedger();
    const page = recorded().pages.get('324616618')!;
    const withPage = [...ledger, pageEntry('hd-page:324616618', page, bundleIdentity(q), '324616618')];
    const p: ResearchPart[] = [{ model: SIBLING, qty: 1, quotes: [{ quote: rowLine(ledger, 'hd-search:1', SIBLING), sourceId: 'hd-search:1' }, { quote: INCLUDES, sourceId: 'bundle' }] }];
    const reasons = reasonsOf(verifyResearch(answer(p), q, withPage, catalog));
    expect(reasons).toContain('PCL500B-PCL525B is itself a bundle of PCL500, PCL525: its own Home Depot page lists them, and the catalog does not know it as a kit. Give those as the parts.');
    expect(reasons).toContain('PCL500B-PCL525B is a combo of 2 tools that the catalog does not know as a kit; give its tools as the parts.');
  });
});
