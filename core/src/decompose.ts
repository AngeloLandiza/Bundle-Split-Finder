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
  /**
   * Step 15 (decision 4): what settled the split when a settle rule did (scan/settle.ts), each with its link: the BOGO
   * pair, Home Depot's own page of each part, a quote of the bundle's page. Absent otherwise.
   */
  evidence?: SplitEvidence[];
  /**
   * Step 15 (decision 4, rule 2): the split waits for Home Depot's reading of these parts (the free part-price read)
   * before it can be settled; it is not a question yet. Absent otherwise. Never set on a resolved split.
   */
  waitingFor?: string[];
}

/** One piece of evidence for a settled split (step 15). `url` is the page it was read on, when there is one. */
export interface SplitEvidence {
  kind: 'hd_part_page' | 'bogo_pair' | 'page_quote';
  text: string;
  url?: string;
}

const norm = (model: string): string => model.toUpperCase().replace(/[-\s]/g, '');

// Longest phrases first, so "hammer drill" wins over "drill". Also read, as whole words, by match.ts (kit extras).
export const KIND_WORDS: readonly string[] = [
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
// starting with a letter, with a digit, four characters or more (the shortest recorded part is
// P553). Wider than RYOBI_MODEL, which still decides automatic resolution. An empty part, a bare
// count ("-2"), a word ("-KIT"), a pack size ("-2PK"), a voltage ("-18V") or a short tag ("-V2")
// is not a model, so it offers no reading. Also the rule for a part the owner types (answers.ts).
export const OFFERABLE_PART = /^(?=[A-Z0-9]{4,}$)[A-Z][A-Z0-9]*\d[A-Z0-9]*$/;

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

  // Form 2: "PBLRC2501SB" -> shared prefix + two 2-digit numbers + SB. Two equal halves
  // (PSK1212SB, a starter kit of batteries and a charger) are not two parts: the model falls
  // through to the forms below, as if the pattern did not match (Ruling 75).
  const m = RYOBI_SB.exec(model);
  if (m && m[2] !== m[3]) {
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
// e.g. DCK940D2WCF891B = kit DCK940D2 "with" DCF891B. A kit's name ends in at most two
// letter-digit groups (DCK200D1P1); a group may have two letters other than W (DCK316ST2M1), so a
// W is never read into the kit's name.
// One kit-name pattern for both forms, so the two cannot drift.
const DEWALT_KIT_NAME = String.raw`DCK[A-Z]{0,2}\d{3,4}(?:[A-Z]\d|[A-VX-Z]{2}\d){0,2}`;
export const DEWALT_BUNDLE = new RegExp(`^(${DEWALT_KIT_NAME})W(.+)$`);
// The kit and a whole tool model, joined with no W: DCK420D2DCS391B = DCK420D2 + DCS391B. Read with
// the model's hyphens kept: DCKTS650D1P1-DCB205 is not this form, and DCK420D2DCB205-2 must never
// offer the model "DCB2052".
const DEWALT_JOINED = new RegExp(`^(${DEWALT_KIT_NAME})(DC[A-Z]{1,2}\\d{3,4}[A-Z]{0,2})$`);
// A battery pack as Home Depot writes one (DEWALT_PACK, 2 to 9), W, a short code: DCB346-3WCS334B.
// Read before hyphens are taken out, since the pack's hyphen is part of its model.
const DEWALT_PACK_WITH = /^(DCB\d+-[2-9])W(.+)$/;

export interface DewaltForm {
  /** kit: <kit>W<short code>. joined: <kit><whole tool model>. pack: <battery pack>W<short code>. */
  kind: 'kit' | 'joined' | 'pack';
  /** The kit or battery pack the model number starts with. */
  base: string;
  /** The bonus item as written: a short code, or a whole model for `joined`; hyphens taken out. */
  bonus: string;
}

/** The Home Depot bundle form a DEWALT model number is written in, or null when it has none. */
export function dewaltBundleForm(bundleModel: string): DewaltForm | null {
  const hyphens = bundleModel.toUpperCase().replace(/\s/g, '');
  const pack = DEWALT_PACK_WITH.exec(hyphens);
  if (pack) return { kind: 'pack', base: pack[1]!, bonus: norm(pack[2]!) };
  const kit = DEWALT_BUNDLE.exec(norm(bundleModel));
  if (kit) return { kind: 'kit', base: kit[1]!, bonus: kit[2]! };
  const joined = DEWALT_JOINED.exec(hyphens);
  if (joined) return { kind: 'joined', base: joined[1]!, bonus: joined[2]! };
  return null;
}

/** The note on a battery pack + bonus item split, which only the owner's answer resolves. */
export const PACK_WITH_NOTE = 'a battery pack with a bonus item is asked, never resolved';

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

/**
 * A kit and a whole tool model (DEWALT_JOINED). The model number spells the tool out, so it is
 * matched whole, never by its ending, and resolves only when the catalog holds exactly that model;
 * otherwise the reading as written is offered (Ruling 29's rule for a RYOBI hyphen bundle).
 */
function decomposeJoined(base: string, tool: string, catalog: Catalog): Decomposition {
  const hits = [...catalog.values()]
    .filter((m) => m.brand === 'DEWALT' && !m.isKit && norm(m.model) === tool)
    .map((m) => m.model)
    .sort();
  if (hits.length === 1) {
    const notes = ['kit + tool, joined without W'];
    if (!catalog.has(base)) notes.push(`kit ${base} is new to the catalog`);
    return { components: [base, hits[0]!], status: 'resolved', notes };
  }
  if (hits.length > 1) {
    return { components: [base], status: 'needs_review', notes: [`'${tool}' fits ${hits.join(' and ')}`], alternatives: hits.map((h) => [base, h]) };
  }
  return { components: [base], status: 'needs_review', notes: [`'${tool}' matches nothing in the catalog`], alternatives: [[base, tool]] };
}

/**
 * A battery pack and a bonus item (DEWALT_PACK_WITH). The short code is read as a kit's is, but the
 * split is never resolved by the model number: no tested rule says a pack base is a product sold on
 * its own. The reading the short code gives is offered for the owner to confirm.
 */
function decomposePackWith(base: string, suffix: string, title: string, catalog: Catalog): Decomposition {
  const { models, problem, readings } = resolveSuffix(suffix, title, catalog);
  const alternatives = problem ? (readings ?? []).map((r) => [base, ...r]).sort(byParts) : [[base, ...models]];
  const split: Decomposition = { components: [base], status: 'needs_review', notes: [problem || 'battery pack + bonus item', PACK_WITH_NOTE] };
  if (alternatives.length > 0) split.alternatives = alternatives;
  return split;
}

export function decomposeDewalt(bundleModel: string, title: string, catalog: Catalog): Decomposition {
  const form = dewaltBundleForm(bundleModel);
  if (!form) {
    const upper = bundleModel.toUpperCase().trim();
    if (catalog.get(upper)?.isKit) return { components: [upper], status: 'resolved', notes: ['manufacturer kit'] };
    return { components: [], status: 'needs_review', notes: ['no known DEWALT bundle pattern'] };
  }
  const { base, bonus: suffix } = form;
  if (form.kind === 'joined') return decomposeJoined(base, suffix, catalog);
  if (form.kind === 'pack') return decomposePackWith(base, suffix, title, catalog);
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
