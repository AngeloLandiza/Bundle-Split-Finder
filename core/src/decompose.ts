// Split a retailer bundle into the model numbers of the things inside it.
//
// Two independent signals are used and then reconciled:
//   1. the bundle's own model number (retailers encode the parts in it),
//   2. component item ids found on the bundle page.
//
// Anything that cannot be resolved to exactly one answer is returned as
// "needs_review". The code never guesses.
//
// v1 stops at the first level: a manufacturer kit inside a bundle (DCK940D2)
// stays one sellable item, because it ships in its own retail box and has its
// own Amazon listing. Breaking a kit into loose tools is a later option.

export interface CatalogModel {
  model: string;
  brand: string;
  /** Tool-type words a retailer title uses for this product. */
  kinds: string[];
  isKit?: boolean;
}

export type Catalog = Map<string, CatalogModel>;

export interface Decomposition {
  components: string[];
  status: 'resolved' | 'needs_review';
  notes: string[];
  /** Whole readings the model number allows when it cannot choose, e.g. kit + DCF891B and kit + DCF921B. */
  alternatives?: string[][];
}

const norm = (model: string): string => model.toUpperCase().replace(/[-\s]/g, '');

// Longest phrases first, so "hammer drill" wins over "drill".
const KIND_WORDS = [
  'impact wrench', 'impact driver', 'hammer drill', 'rotary hammer', 'drill', 'oscillating',
  'reciprocating saw', 'circular saw', 'jig saw', 'jigsaw', 'miter saw', 'table saw', 'band saw',
  'router', 'ratchet', 'blower', 'vac', 'sander', 'grinder', 'nailer', 'stapler', 'planer',
  'inflator', 'light', 'radio', 'fan', 'trimmer', 'chainsaw', 'battery', 'batteries', 'charger',
];

/** Tool-type words found in a retailer title, used to tell similar model numbers apart. */
export function kindsFromTitle(title: string): string[] {
  let low = ` ${title.toLowerCase()} `;
  const found: string[] = [];
  for (const word of KIND_WORDS) {
    if (low.includes(word)) {
      found.push(word);
      low = low.split(word).join(' '); // so "hammer drill" does not also count as "drill"
    }
  }
  return found;
}

/** Add a product seen on a retailer page or search result to the catalog. */
export function catalogEntry(brand: string, model: string, title: string): CatalogModel {
  const m = model.toUpperCase().trim();
  const isKit = /\b(combo kit|\d+-tool|\d+ tool)\b/i.test(title) && /^(DCK|PCL\d+K|P\d+K)/.test(m);
  return { model: m, brand: brand.toUpperCase().trim(), kinds: kindsFromTitle(title), isKit };
}

// ---------------------------------------------------------------- RYOBI

const RYOBI_MODEL = /^[A-Z]{1,6}\d{2,5}[A-Z0-9]*$/;
const RYOBI_SB = /^([A-Z]{2,6})(\d{2})(\d{2})SB$/;
// A hyphen part that can be offered to the owner as a model number: upper-case letters and digits,
// with at least one of each. Wider than RYOBI_MODEL, which still decides automatic resolution; an
// empty part, a bare count ("-2") or a word ("-KIT") is not a model, so it offers no reading.
const OFFERABLE_PART = /^(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]+$/;

// A split in review offers, as `alternatives`, the reading its model number spells out (Ruling 29):
// the owner may confirm it, but only the owner's answer turns it into the split.
export function decomposeRyobi(bundleModel: string, catalog: Catalog): Decomposition {
  const model = bundleModel.toUpperCase().trim();

  // Form 1: "PBLRC01B-PBLRC25B" -> the parts are spelled out.
  if (model.includes('-')) {
    const parts = model.split('-');
    if (parts.every((p) => RYOBI_MODEL.test(p) && catalog.has(p))) {
      return { components: parts, status: 'resolved', notes: ['hyphen-joined model numbers'] };
    }
    const split: Decomposition = { components: parts, status: 'needs_review', notes: ['hyphen split, but a part is not in the catalog'] };
    if (parts.every((p) => OFFERABLE_PART.test(p))) split.alternatives = [[...parts]];
    return split;
  }

  // Form 2: "PBLRC2501SB" -> shared prefix + two 2-digit numbers + SB.
  const m = RYOBI_SB.exec(model);
  if (m) {
    const [, prefix, a, b] = m;
    const parts = [`${prefix}${a}B`, `${prefix}${b}B`];
    if (parts.every((p) => catalog.has(p))) {
      return { components: parts, status: 'resolved', notes: ['special-buy model number expanded'] };
    }
    return { components: [], status: 'needs_review', notes: ['special-buy pattern, parts not in catalog'], alternatives: [parts] };
  }

  if (catalog.get(model)?.isKit) {
    return { components: [model], status: 'resolved', notes: ['manufacturer kit'] };
  }
  return { components: [], status: 'needs_review', notes: ['no known RYOBI bundle pattern'] };
}

// ---------------------------------------------------------------- DEWALT

// Home Depot writes DEWALT bundles as <kit model>W<short code for the bonus item>,
// e.g. DCK940D2WCF891B = kit DCK940D2 "with" DCF891B.
export const DEWALT_BUNDLE = /^(DCK[A-Z]{0,2}\d{3,4}(?:[A-Z]\d){0,2})W(.+)$/;

function suffixCandidates(suffix: string, title: string, catalog: Catalog): string[] {
  const hits = [...catalog.values()]
    .filter((m) => m.brand === 'DEWALT' && !m.isKit)
    .filter((m) => norm(m.model).endsWith(suffix) || norm(m.model).endsWith(`${suffix}B`))
    .map((m) => m.model);
  if (hits.length <= 1) return hits;
  const titleKinds = new Set(kindsFromTitle(title));
  const byTitle = hits.filter((h) => catalog.get(h)!.kinds.some((k) => titleKinds.has(k)));
  return byTitle.length ? byTitle : hits;
}

/**
 * The bonus items a short code names. `readings` (each a list of bonus items) is set only when
 * the code fits more than one way; it lists exactly the candidates the problem names.
 */
function resolveSuffix(suffix: string, title: string, catalog: Catalog): { models: string[]; problem: string; readings?: string[][] } {
  const whole = suffixCandidates(suffix, title, catalog);
  if (whole.length === 1) return { models: whole, problem: '' };
  if (whole.length > 1) {
    const sorted = [...whole].sort();
    return { models: [], problem: `'${suffix}' fits ${sorted.join(' and ')}`, readings: sorted.map((m) => [m]) };
  }

  // Two bonus items can be glued together: "354606" = DCS354B + DCB606.
  const splits: string[][] = [];
  for (let cut = 2; cut < suffix.length - 1; cut++) {
    const left = suffixCandidates(suffix.slice(0, cut), title, catalog);
    const right = suffixCandidates(suffix.slice(cut), title, catalog);
    if (left.length === 1 && right.length === 1) splits.push([...left, ...right]);
  }
  if (splits.length === 1) return { models: splits[0]!, problem: '' };
  if (splits.length > 1) return { models: [], problem: `'${suffix}' can be split more than one way`, readings: splits };
  return { models: [], problem: `'${suffix}' matches nothing in the catalog` };
}

const byParts = (a: string[], b: string[]): number => {
  const x = a.join(',');
  const y = b.join(',');
  return x < y ? -1 : x > y ? 1 : 0;
};

export function decomposeDewalt(bundleModel: string, title: string, catalog: Catalog): Decomposition {
  const model = norm(bundleModel);
  const m = DEWALT_BUNDLE.exec(model);
  if (!m) {
    const upper = bundleModel.toUpperCase().trim();
    if (catalog.get(upper)?.isKit) return { components: [upper], status: 'resolved', notes: ['manufacturer kit'] };
    return { components: [], status: 'needs_review', notes: ['no known DEWALT bundle pattern'] };
  }
  const base = m[1]!;
  const suffix = m[2]!;
  const { models, problem, readings } = resolveSuffix(suffix, title, catalog);
  if (problem) {
    const split: Decomposition = { components: [base], status: 'needs_review', notes: [problem] };
    // The owner chooses among these; the split itself stays in review.
    if (readings) split.alternatives = readings.map((r) => [base, ...r]).sort(byParts);
    return split;
  }
  const notes = ['kit + bonus item'];
  if (!catalog.has(base)) notes.push(`kit ${base} is new to the catalog`);
  return { components: [base, ...models], status: 'resolved', notes };
}

export function decompose(brand: string, bundleModel: string, title: string, catalog: Catalog): Decomposition {
  const b = brand.toUpperCase().trim();
  if (b === 'RYOBI') return decomposeRyobi(bundleModel, catalog);
  if (b === 'DEWALT') return decomposeDewalt(bundleModel, title, catalog);
  return { components: [], status: 'needs_review', notes: [`no splitting rules for ${brand} yet`] };
}

// ---------------------------------------------------------------- reconciliation

export type Confidence = 'high' | 'medium' | 'conflict' | 'none';

/** Compare what the model number says with what the page says. Two signals agreeing is "high". */
export function reconcile(fromModelNumber: string[], fromPage: string[]): { confidence: Confidence; reason: string } {
  const a = new Set(fromModelNumber);
  const b = new Set(fromPage);
  const same = a.size === b.size && [...a].every((x) => b.has(x));
  if (a.size && b.size && same) return { confidence: 'high', reason: 'model number and page component ids agree' };
  if (a.size && b.size) {
    return {
      confidence: 'conflict',
      reason: `model number says ${[...a].sort().join(', ')}; page says ${[...b].sort().join(', ')}`,
    };
  }
  if (a.size || b.size) return { confidence: 'medium', reason: 'only one signal available' };
  return { confidence: 'none', reason: 'no signal' };
}
