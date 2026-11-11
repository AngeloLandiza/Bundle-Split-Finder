import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decompose, type Catalog, type Decomposition } from '../src/decompose';
import { parseBundlePage, type PageContent } from '../src/hdPage';
import { pageCatalog, splitWithPage } from '../src/pageSplit';
import * as fx from './fixtures';

interface Rec { itemId: string; status: number; text: string }
const pages = (
  JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pages-2026-11-10.json', import.meta.url), 'utf8')) as {
    pages: Rec[];
  }
).pages;

/** The bundle page of a recorded item, read with the page parser. */
const read = (id: string): PageContent => {
  const r = pages.find((p) => p.itemId === id);
  if (!r) throw new Error(`no recorded page ${id}`);
  const got = parseBundlePage(r.text, id);
  if (!got) throw new Error(`recorded page ${id} does not parse`);
  return got;
};

/** Stored models of the bundle's brand; DCK and PSK models are kits. */
const knownOf = (brand: string, models: string[]): Catalog =>
  new Map(models.map((model) => [model, { model, brand, kinds: [], isKit: /^(DCK|PSK)/.test(model) }]));

interface Case { brand: string; model: string; known?: string[]; page: PageContent | null; title?: string }

/** The runner's split from the model number, then the split once the page is read. */
const run = ({ brand, model, known = [], page, title = '' }: Case): { modelSplit: Decomposition; got: Decomposition } => {
  const catalog = knownOf(brand, known);
  const modelSplit = decompose(brand, model, title, catalog);
  return { modelSplit, got: splitWithPage({ brand, model, title }, modelSplit, page, catalog) };
};

const sorted = (xs: string[]): string[] => [...xs].sort();

describe('pageCatalog', () => {
  it('DEWALT: takes only the model that leads each bullet, the kit marked as a kit', () => {
    const cat = pageCatalog('DEWALT', read('337440459').bullets);
    expect(sorted([...cat.keys()])).toEqual(['DCF921B', 'DCK200D1P1']); // never DCD799 or DCF850
    expect(cat.get('DCK200D1P1')).toEqual({ model: 'DCK200D1P1', brand: 'DEWALT', kinds: [], isKit: true });
    expect(cat.get('DCF921B')).toEqual({ model: 'DCF921B', brand: 'DEWALT', kinds: [], isKit: false });
  });

  it('DEWALT: a page whose bullets do not lead with a model names nothing', () => {
    expect(pageCatalog('DEWALT', read('206510146').bullets).size).toBe(0); // "DEWALT DCD771 20-Volt MAX ..."
  });

  it('RYOBI: models in the Includes bullets, each also with the tool-only B', () => {
    const cat = pageCatalog('RYOBI', read('328814689').bullets);
    expect(sorted([...cat.keys()])).toEqual(['PBLRC01', 'PBLRC01B', 'PBLRC25', 'PBLRC25B']); // not 18V
    expect(cat.get('PBLRC25B')).toEqual({ model: 'PBLRC25B', brand: 'RYOBI', kinds: [], isKit: false });
  });

  it('RYOBI: reads every Includes bullet and skips 18T and 18V', () => {
    const cat = pageCatalog('RYOBI', read('341645081').bullets);
    expect(sorted([...cat.keys()])).toEqual(sorted(
      ['PCL206', 'PCL235', 'PCL500', 'PCL515', 'PCL430', 'PCL660', 'PBP005', 'PBP002'].flatMap((m) => [m, `${m}B`]),
    ));
  });

  it('RYOBI: a model outside an Includes bullet does not count', () => {
    // 328690510: "Don't forget your ... Blade (A065101) and ... Set (A143001)"; its Includes bullet names no model.
    expect(read('328690510').bullets.some((b) => b.includes('A065101'))).toBe(true);
    expect(pageCatalog('RYOBI', read('328690510').bullets).size).toBe(0);
  });

  it('any other brand: empty', () => {
    expect(pageCatalog('MILWAUKEE', read('337440459').bullets).size).toBe(0);
    expect(pageCatalog('MILWAUKEE', read('328814689').bullets).size).toBe(0);
  });
});

interface Row extends Case {
  item: string;
  status: 'resolved' | 'needs_review';
  /** Expected parts, as a set; omitted for a bundle left to review. */
  parts?: string[];
  notes: string[];
}

const p = read;
const ROWS: Row[] = [
  { item: '328814689', brand: 'RYOBI', model: 'PBLRC2501SB', page: p('328814689'),
    status: 'resolved', parts: ['PBLRC01B', 'PBLRC25B'], notes: ['split read from the page'] },
  { item: '328814689', brand: 'RYOBI', model: 'PBLRC2501SB', known: ['PBLRC01B', 'PBLRC25B'], page: p('328814689'),
    status: 'resolved', parts: ['PBLRC01B', 'PBLRC25B'], notes: ['model number and page agree'] },
  { item: '320683876', brand: 'RYOBI', model: 'PBLRC25B-PBP004', page: p('320683876'),
    status: 'resolved', parts: ['PBLRC25B', 'PBP004'], notes: ['split read from the page'] },
  { item: '327939252', brand: 'RYOBI', model: 'PCL280B-PSK005', page: p('327939252'),
    status: 'needs_review', notes: ['hyphen split, but a part is not in the catalog'] },
  { item: '327939252', brand: 'RYOBI', model: 'PCL280B-PSK005', known: ['PSK005'], page: p('327939252'),
    status: 'resolved', parts: ['PCL280B', 'PSK005'], notes: ['parts known from the catalog and the page'] },
  { item: '341645081', brand: 'RYOBI', model: 'PCL1600K2-PBP004', known: ['PCL1600K2', 'PBP004'], page: p('341645081'),
    status: 'resolved', parts: ['PBP004', 'PCL1600K2'],
    notes: ['hyphen-joined model numbers', 'page does not name PBP004, PCL1600K2'] },
  { item: '341645081', brand: 'RYOBI', model: 'PCL1600K2-PBP004', page: p('341645081'),
    status: 'needs_review', notes: ['hyphen split, but a part is not in the catalog'] },
  { item: '328690510', brand: 'RYOBI', model: 'PCL500525SB', page: p('328690510'),
    status: 'needs_review', notes: ['no known RYOBI bundle pattern', 'page names no models'] },
  { item: '335849279', brand: 'RYOBI', model: 'PBLRC2501SB-A13401', page: p('335849279'),
    status: 'needs_review', notes: ['hyphen split, but a part is not in the catalog'] },
  { item: '337440459', brand: 'DEWALT', model: 'DCK200D1P1W921B', page: p('337440459'),
    status: 'resolved', parts: ['DCF921B', 'DCK200D1P1'], notes: ['split read from the page'] },
  { item: '337440459', brand: 'DEWALT', model: 'DCK200D1P1W921B', known: ['DCF921B'], page: p('337440459'),
    status: 'resolved', parts: ['DCF921B', 'DCK200D1P1'], notes: ['model number and page agree'] },
  { item: "337440459's bullets", brand: 'DEWALT', model: 'DCK200D1P1WB606', known: ['DCB606'], page: p('337440459'),
    status: 'needs_review',
    notes: ['model number says DCB606, DCK200D1P1', 'page names DCF921B, DCK200D1P1, which do not fit the model number'] },
  { item: '337440461', brand: 'DEWALT', model: 'DCK200D1P1WB606', page: p('337440461'),
    status: 'resolved', parts: ['DCB606', 'DCK200D1P1'], notes: ['split read from the page'] },
  { item: '343992133', brand: 'DEWALT', model: 'DCK540D1WCS334B', page: p('343992133'),
    status: 'resolved', parts: ['DCK540D1', 'DCS334B'], notes: ['split read from the page'] },
  { item: '343992132', brand: 'DEWALT', model: 'DCK540D1WCS565B', page: p('343992132'),
    status: 'resolved', parts: ['DCK540D1', 'DCS565B'], notes: ['split read from the page'] },
];

describe('splitWithPage: the table', () => {
  for (const row of ROWS) {
    const label = `${row.item} ${row.model}, known ${row.known?.join(', ') || 'none'}: ${row.status}; ${row.notes.join('; ')}`;
    it(label, () => {
      const { got } = run(row);
      expect(got.status).toBe(row.status);
      expect(got.notes).toEqual(row.notes);
      if (row.parts) expect(sorted(got.components)).toEqual(sorted(row.parts));
    });
  }

  it('page null: every row keeps its model-number split, no note', () => {
    for (const row of ROWS) {
      const { modelSplit, got } = run({ ...row, page: null });
      expect(got, row.item).toEqual(modelSplit);
    }
  });
});

describe('splitWithPage: a DEWALT page silent beyond the kit', () => {
  const kitOnly: PageContent = { ...p('337440459'), bullets: p('337440459').bullets.filter((b) => b.startsWith('DCK200D1P1:')) };

  it('names only the kit: a resolved model split stands, with the parts the page does not name', () => {
    const { modelSplit, got } = run({ brand: 'DEWALT', model: 'DCK200D1P1W921B', known: ['DCF921B'], page: kitOnly });
    expect(kitOnly.bullets).toHaveLength(4);
    expect(got).toEqual({ ...modelSplit, notes: [...modelSplit.notes, 'page does not name DCF921B'] });
    expect(got.status).toBe('resolved');
  });

  it('names only the kit: an unresolved model split is unchanged', () => {
    const { modelSplit, got } = run({ brand: 'DEWALT', model: 'DCK200D1P1W921B', page: kitOnly });
    expect(got).toEqual(modelSplit);
    expect(got.status).toBe('needs_review');
  });

});

describe('splitWithPage: a DEWALT page that names no models takes R1', () => {
  // 206510146 is the plain kit DCK940D2; its bullets read "DEWALT DCD771 20-Volt MAX ...".
  it('a resolved kit stands, noting the page names no models', () => {
    const { modelSplit, got } = run({ brand: 'DEWALT', model: 'DCK940D2', known: ['DCK940D2'], page: p('206510146') });
    expect(modelSplit.status).toBe('resolved');
    expect(got).toEqual({ ...modelSplit, notes: ['manufacturer kit', 'page names no models'] });
  });

  it('an unresolved model split stays in review, noting the page names no models', () => {
    const { modelSplit, got } = run({ brand: 'DEWALT', model: 'DCK940D2', page: p('206510146') });
    expect(modelSplit.status).toBe('needs_review');
    expect(got).toEqual({ ...modelSplit, notes: ['no known DEWALT bundle pattern', 'page names no models'] });
  });
});

describe('splitWithPage: a DEWALT page naming another kit', () => {
  // 337440459 names DCK200D1P1 and DCF921B; the model number says kit DCK240C2. The page catalog
  // resolves '921B', but the page's split is not the set of models it names.
  const page = p('337440459');
  const misfit = 'page names DCF921B, DCK200D1P1, which do not fit the model number';

  it('model split resolved: to review, both readings in the reason', () => {
    const { modelSplit, got } = run({ brand: 'DEWALT', model: 'DCK240C2W921B', known: ['DCF921B'], page });
    expect(modelSplit.status).toBe('resolved');
    expect(got).toEqual({
      components: modelSplit.components, status: 'needs_review', notes: ['model number says DCF921B, DCK240C2', misfit],
      alternatives: [['DCK240C2', 'DCF921B'], ['DCK200D1P1', 'DCF921B']],
    });
  });

  it('model split unresolved: stays in review, with the page reading added', () => {
    const { modelSplit, got } = run({ brand: 'DEWALT', model: 'DCK240C2W921B', page });
    expect(modelSplit.status).toBe('needs_review');
    expect(got).toEqual({ ...modelSplit, notes: [...modelSplit.notes, misfit], alternatives: [['DCK200D1P1', 'DCF921B']] });
  });

  it('neither split resolved: stays in review, with the page reading added', () => {
    // 337440459's bullets against DCK200D1P1WB606: 'B606' fits nothing the page names, nor anything known.
    const { modelSplit, got } = run({ brand: 'DEWALT', model: 'DCK200D1P1WB606', page });
    expect(modelSplit.status).toBe('needs_review');
    expect(got).toEqual({ ...modelSplit, notes: ["'B606' matches nothing in the catalog", misfit], alternatives: [['DCK200D1P1', 'DCF921B']] });
  });
});

describe('splitWithPage: other cases', () => {
  it("both resolved to different parts: to review with reconcile's reason", () => {
    // A stored model that also ends in 921B (constructed: no real one is recorded) gives a second reading.
    const { got } = run({ brand: 'DEWALT', model: 'DCK200D1P1W921B', known: ['DCD921B'], page: p('337440459') });
    expect(got.status).toBe('needs_review');
    expect(got.notes).toEqual(['model number says DCD921B, DCK200D1P1; page says DCF921B, DCK200D1P1']);
  });

  it('a plain RYOBI kit whose page lists its loose tools: the kit stands', () => {
    // 317987591 is PCL1600K2; its Includes bullets name PCL206, PCL235, ... but not the kit.
    const catalog: Catalog = new Map([['PCL1600K2', { model: 'PCL1600K2', brand: 'RYOBI', kinds: [], isKit: true }]]);
    const modelSplit = decompose('RYOBI', 'PCL1600K2', '', catalog);
    const got = splitWithPage({ brand: 'RYOBI', model: 'PCL1600K2', title: '' }, modelSplit, p('317987591'), catalog);
    expect(got).toEqual({ ...modelSplit, notes: ['manufacturer kit', 'page does not name PCL1600K2'] });
  });

  it('a brand with no page rules: the model split, noting the page names no models', () => {
    const { modelSplit, got } = run({ brand: 'MILWAUKEE', model: '3697-22', page: p('337440459') });
    expect(got).toEqual({ ...modelSplit, notes: [...modelSplit.notes, 'page names no models'] });
  });
});

describe('splitWithPage: the readings the owner can choose from (step 5)', () => {
  const misfit = 'page names DCF921B, DCK200D1P1, which do not fit the model number';

  it("337440459's page with model DCK200D1P1WB606: the model-number reading, then the page reading", () => {
    const { got } = run({ brand: 'DEWALT', model: 'DCK200D1P1WB606', known: ['DCB606'], page: p('337440459') });
    expect(got.status).toBe('needs_review');
    expect(got.alternatives).toEqual([['DCK200D1P1', 'DCB606'], ['DCK200D1P1', 'DCF921B']]);
  });

  it('both resolved to different parts: the model-number reading, then the page reading', () => {
    const { got } = run({ brand: 'DEWALT', model: 'DCK200D1P1W921B', known: ['DCD921B'], page: p('337440459') });
    expect(got.status).toBe('needs_review');
    expect(got.alternatives).toEqual([['DCK200D1P1', 'DCD921B'], ['DCK200D1P1', 'DCF921B']]);
  });

  it("the model number cannot choose and the page does not fit: the page reading, then the model number's readings", () => {
    // The real bundle DCKTS650D1P1W1B read with 337440459's page (a constructed pairing, as in the misfit cases above).
    const [model, title] = fx.HD_DEWALT_AMBIGUOUS;
    const { modelSplit, got } = run({ brand: 'DEWALT', model, title, known: ['DCF891B', 'DCF921B'], page: p('337440459') });
    expect(modelSplit.alternatives).toEqual([['DCKTS650D1P1', 'DCF891B'], ['DCKTS650D1P1', 'DCF921B']]);
    expect(got).toEqual({
      components: ['DCKTS650D1P1'], status: 'needs_review', notes: ["'1B' fits DCF891B and DCF921B", misfit],
      alternatives: [['DCK200D1P1', 'DCF921B'], ['DCKTS650D1P1', 'DCF891B'], ['DCKTS650D1P1', 'DCF921B']],
    });
  });

  it("a page that adds nothing keeps the model number's readings", () => {
    const [model, title] = fx.HD_DEWALT_AMBIGUOUS;
    const noModels: PageContent = { ...p('337440459'), bullets: [] };
    const { modelSplit, got } = run({ brand: 'DEWALT', model, title, known: ['DCF891B', 'DCF921B'], page: noModels });
    expect(got).toEqual({ ...modelSplit, notes: [...modelSplit.notes, 'page names no models'] });
    expect(got.alternatives).toEqual([['DCKTS650D1P1', 'DCF891B'], ['DCKTS650D1P1', 'DCF921B']]);
  });

  describe('a page that names no kit is silent about it: its models are not offered as a reading', () => {
    // Constructed: 337440459's page with only its DCF921B bullets, so no kit model leads a bullet.
    const noKit: PageContent = { ...p('337440459'), bullets: p('337440459').bullets.filter((b) => b.startsWith('DCF921B:')) };
    const silent = 'page names DCF921B, which do not fit the model number';

    it('the page has bullets, none naming a kit', () => {
      expect(noKit.bullets.length).toBeGreaterThan(0);
      expect([...pageCatalog('DEWALT', noKit.bullets).values()].map((e) => [e.model, e.isKit])).toEqual([['DCF921B', false]]);
    });

    it('model split resolved (R3): to review with the note, offering the model-number reading only', () => {
      const { modelSplit, got } = run({ brand: 'DEWALT', model: 'DCK240C2W921B', known: ['DCF921B'], page: noKit });
      expect(modelSplit.status).toBe('resolved');
      expect(got).toEqual({
        components: ['DCK240C2', 'DCF921B'], status: 'needs_review', notes: ['model number says DCF921B, DCK240C2', silent],
        alternatives: [['DCK240C2', 'DCF921B']],
      });
    });

    it('model split unresolved (R5): the note, and no reading to offer', () => {
      const { modelSplit, got } = run({ brand: 'DEWALT', model: 'DCK240C2W921B', page: noKit });
      expect(modelSplit.status).toBe('needs_review');
      expect(got).toEqual({ ...modelSplit, notes: ["'921B' matches nothing in the catalog", silent] });
      expect(got.alternatives).toBeUndefined();
    });

    it("model number cannot choose (R5): the note, and only the model number's readings", () => {
      const [model, title] = fx.HD_DEWALT_AMBIGUOUS;
      const { modelSplit, got } = run({ brand: 'DEWALT', model, title, known: ['DCF891B', 'DCF921B'], page: noKit });
      expect(got).toEqual({ ...modelSplit, notes: ["'1B' fits DCF891B and DCF921B", silent] });
      expect(got.alternatives).toEqual([['DCKTS650D1P1', 'DCF891B'], ['DCKTS650D1P1', 'DCF921B']]);
    });
  });

  it('a resolved split lists no alternatives', () => {
    for (const row of ROWS.filter((r) => r.status === 'resolved')) expect(run(row).got.alternatives, row.item).toBeUndefined();
  });
});
