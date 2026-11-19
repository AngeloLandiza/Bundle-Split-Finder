// The code-side check of a judge's answer. The model's word alone never makes a match: every quote
// must be found in the listing, a match must quote the model number and what the listing includes,
// and every field must say one New unit of exactly the product, nothing added and nothing missing.
// Anything short of that is unsure (CLAUDE.md rule 4). Checks here only ever lower a verdict, never
// raise one. The listing checks below are words, not understanding: each comes from a recorded
// listing (fixtures/ebay/) and is measured against the labels (fixtures/ebay/labels.json).

import { itemSpecifics, PROMPT_VERSION } from './prompt';
import { parseJudgeRaw } from './schema';
import type { JudgeInput, JudgeOutcome, JudgeRaw, ListingJudge, VerifiedJudgement } from './types';

/** eBay's condition id for New. */
const EBAY_NEW = '1000';

/**
 * Case, spacing and typographic marks are not evidence: curly quotes, dashes and no-break spaces
 * read as their plain forms. Nothing else is changed.
 */
export function normaliseText(text: string): string {
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The places a quote may come from, each searched on its own: a quote never spans two of them. */
function quoteSources(input: JudgeInput): string[] {
  const { listing } = input;
  return [listing.title, ...itemSpecifics(listing), listing.descriptionText].map(normaliseText).filter((s) => s !== '');
}

const isAlnum = (c: string | undefined) => c !== undefined && /[a-z0-9]/.test(c);

/**
 * Where `model` first appears in `text` as a whole model number (normalised text), or -1. PCL206 is
 * not found in PCL206B or PCL206K1: a longer model number is another product.
 */
export function findModel(text: string, model: string): number {
  const m = normaliseText(model);
  if (m === '') return -1;
  for (let at = text.indexOf(m); at >= 0; at = text.indexOf(m, at + 1)) {
    if (!isAlnum(text[at - 1]) && !isAlnum(text[at + m.length])) return at;
  }
  return -1;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- Counts and packs -----------------------------------------------------------------------------

const PACK_COUNT = /\b(\d+)\s*-?\s*(pk|pks|pack|packs|pcs|pc|piece|pieces|count|ct|lot)\b/g;
const PACK_OF = /\b(pack|lot|set) of\s*(\d+)?/g;

const UNIT: Record<string, string> = {
  pk: 'pack',
  pks: 'pack',
  pack: 'pack',
  packs: 'pack',
  pcs: 'piece',
  pc: 'piece',
  piece: 'piece',
  pieces: 'piece',
  count: 'count',
  ct: 'count',
  lot: 'lot',
  set: 'set',
};

/** Counts a text states ("2 Pk", "65-Piece", "pack of 2"), each keyed by number and unit ("2:pack"). */
function packCounts(text: string): { said: string; key: string }[] {
  const out: { said: string; key: string }[] = [];
  for (const m of text.matchAll(PACK_COUNT)) out.push({ said: m[0], key: `${Number(m[1])}:${UNIT[m[2]!]}` });
  for (const m of text.matchAll(PACK_OF)) out.push({ said: m[0].trim(), key: m[2] ? `${Number(m[2])}:${UNIT[m[1]!]}` : 'unknown' });
  return out;
}

/** The counts the part itself states: in its name ("(2-Pack)"), or a model's own suffix (DCB203-2). */
function ownCounts(input: JudgeInput): Set<string> {
  const own = new Set(packCounts(normaliseText(input.part.title ?? '')).map((c) => c.key));
  const suffix = normaliseText(input.part.model).match(/-(\d+)$/);
  if (suffix) own.add(`${Number(suffix[1])}:pack`);
  return own;
}

// --- Components and negation ----------------------------------------------------------------------

// What a part's name can say its product includes besides its main item. A name saying the product
// comes without them ("Tool Only", "not included", "sold separately") asks for none of them.
const COMPONENTS: [string, RegExp][] = [
  ['battery', /\bbatter(y|ies)\b/],
  ['charger', /\bchargers?\b/],
  ['bag', /\bbags?\b/],
  ['case', /\bcases?\b/],
];
const WITHOUT = /\btools? only\b|\bnot included\b|\bsold separately\b/;

/** What the part's name says the product includes, each to be named by a contents quote. */
export function namedComponents(partTitle: string | undefined): string[] {
  const name = normaliseText(partTitle ?? '');
  if (name === '' || WITHOUT.test(name)) return [];
  return COMPONENTS.filter(([, re]) => re.test(name)).map(([word]) => word);
}

const ABSENT = String.raw`(are |is )?(not included|not incl|sold separately|sold seperately|separately|seperately)`;
const COMPONENT_WORD = String.raw`(batter(y|ies)|chargers?|bags?|cases?)`;

/**
 * A component named only to say it is absent is not named: "no charger", "battery not included",
 * and a list before the negation, "battery, charger and bag are not included" (fix round 2).
 */
const NEGATED = new RegExp(
  String.raw`\b(no|without|w/o)\s+(\S+\s+){0,2}?${COMPONENT_WORD}\b|${COMPONENT_WORD}\b[^.!?()]{0,60}?\b${ABSENT}`,
  'g',
);

/** Text right after a quote that takes back what it said: "… charger | are not included". */
const NEGATION_AFTER = new RegExp(String.raw`^[\s,.;:)*\-]*(\(?which |that )?${ABSENT}`);
/** Text right before a quote that takes it back: "no | battery or charger". */
const NEGATION_BEFORE = /\b(no|without|w\/o|not)\s*$/;

/**
 * A quote cut short before (or just after) a negation in its own field does not say what it seems
 * to: "battery and charger" from "battery and charger (which are not included)".
 */
function isCutBeforeNegation(quote: string, sources: string[]): boolean {
  const q = normaliseText(quote);
  if (q === '') return false;
  let found = false;
  for (const s of sources) {
    for (let at = s.indexOf(q); at >= 0; at = s.indexOf(q, at + 1)) {
      found = true;
      const after = s.slice(at + q.length, at + q.length + 40);
      const before = s.slice(Math.max(0, at - 12), at);
      if (!NEGATION_AFTER.test(after) && !NEGATION_BEFORE.test(before)) return false;
    }
  }
  return found;
}

// --- The kit ruling (fix round 2) -----------------------------------------------------------------

/** "pulled from a DCK240C2 kit", "taken out of the kit": the model names where a tool came from. */
const KIT_PULL = /\b(from|out of)\s+(a\s+|an\s+|the\s+)?(\S+\s+){0,3}?kit\b|\bkit[- ]pull|\bpulled\b|\btaken (out|from)\b/;

/** The listing anywhere says a component the product includes is absent, or sells only part of it. */
function deniesComponents(input: JudgeInput, components: string[]): string | null {
  const text = [input.listing.title, ...itemSpecifics(input.listing), input.listing.descriptionText].map(normaliseText).join(' \u0000 ');
  if (/\b(tools?|bare tool|body|battery|batteries|charger) only\b|\bbare tools?\b/.test(text)) {
    return text.match(/\b(tools?|bare tool|body|battery|batteries|charger) only\b|\bbare tools?\b/)![0];
  }
  for (const word of components) {
    const w = word === 'battery' ? 'batter(y|ies)' : `${word}s?`;
    const re = new RegExp(String.raw`\b(no|without|w/o)\s+(\S+\s+){0,2}?${w}\b|\b${w}\b[^.!?()\u0000]{0,60}?\b${ABSENT}|\b${w} included: no\b`);
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

// --- Listing checks for a match -------------------------------------------------------------------

const ACCESSORY_BEFORE_MODEL = /\b(for|fits|compatible)\b/;
/** Accessory words anywhere in the title (fix round 2): after the model they mean the same. */
const ACCESSORY_ANYWHERE = /\bcompatible\b|\bfits\b|\breplacement\b.*\bfor\b|\bfor (dewalt|de walt|ryobi)\b|\bmotor assembly\b|\bgear ?box\b/;
/** Condition words a title can say while eBay's condition id says New. */
const CONDITION_WORDS = /\bopen[- ]?box\b|\buntested\b|(?<!\bnever |\bnot |\bun)\bused\b|\brefurbished\b|\breconditioned\b|\bfor parts\b|\bparts only\b|\bas[- ]is\b/;
const PLACEHOLDER_BRAND = /^(unbranded|does not apply|branded|n\/?a|na|generic|none|no brand|unknown)$/;
/** Item specifics that name a model number. */
const MODEL_ASPECTS = new Set(['mpn', 'model', 'manufacturer part number', 'part number', 'item model number']);

const NO_WORD = /\b(no|without|w\/o)\s+([a-z]+)/g;
const PACKAGING_OR_POWER = new Set(['box', 'retail', 'packaging', 'package', 'tag', 'tags', 'battery', 'batteries', 'charger', 'chargers']);

/** Brand words for a part's brand; TTI makes RYOBI. */
const brandWords = (brand: string): string[] => {
  const b = normaliseText(brand).replace(/[^a-z0-9]/g, '');
  return b === 'ryobi' ? ['ryobi', 'tti'] : b === 'dewalt' ? ['dewalt'] : [b];
};

const modelParts = (m: string): { letters: string; digits: string } | null => {
  const x = normaliseText(m).match(/^([a-z]+)(\d+)/);
  return x ? { letters: x[1]!, digits: x[2]! } : null;
};

/**
 * Title and item-specific checks for a match, from the hard cases in the recordings. Each one only
 * lowers. `models` is the part's model and twin.
 */
function listingProblems(input: JudgeInput, models: string[]): string[] {
  const { listing, part } = input;
  const title = normaliseText(listing.title);
  const problems: string[] = [];

  // "Hard Case for RYOBI … PCL206B", "Toolbox Insert for PCL206B".
  const firstModel = Math.min(...models.map((m) => findModel(title, m)).map((i) => (i < 0 ? Infinity : i)));
  const before = Number.isFinite(firstModel) ? title.slice(0, firstModel) : title;
  const accessory = before.match(ACCESSORY_BEFORE_MODEL) ?? title.match(ACCESSORY_ANYWHERE);
  if (accessory) problems.push(`The title says "${accessory[0]}", as accessories and compatible parts do.`);

  // "2 Pk", "2Pack", "lot of": unless the part itself states that count ("65-Piece", "(2-Pack)").
  const own = ownCounts(input);
  for (const count of packCounts(title)) {
    if (!own.has(count.key)) problems.push(`The title says "${count.said}", which may mean more than one unit.`);
  }
  // DCB205-2: a pack form of the model, unless the part states that count.
  for (const m of models) {
    const re = new RegExp(String.raw`(?<![a-z0-9])${escapeRe(normaliseText(m))}-(\d+)\b`, 'g');
    for (const hit of [title, ...itemSpecifics(listing).map(normaliseText)].flatMap((t) => [...t.matchAll(re)])) {
      if (!own.has(`${Number(hit[1])}:pack`)) problems.push(`The listing names "${hit[0]}", a pack form of the model.`);
    }
  }

  // "No Blades": a piece the product includes is missing.
  const included = namedComponents(part.title);
  for (const m of title.matchAll(NO_WORD)) {
    const word = m[2]!;
    const isComponent = COMPONENTS.find(([, re]) => re.test(word));
    if (PACKAGING_OR_POWER.has(word) && !(isComponent && included.includes(isComponent[0]))) continue;
    problems.push(`The title says "${m[0]}", which may mean a piece the product includes is missing.`);
  }

  // "NEW Open Box", "Untested": a condition eBay's New does not show.
  const condition = title.match(CONDITION_WORDS);
  if (condition) problems.push(`The title says "${condition[0]}", which is not New.`);

  // Brand: "Unbranded", "BRANDED", or another maker.
  const brands = [listing.brand, ...listing.aspects.filter((a) => normaliseText(a.name) === 'brand').map((a) => a.value)]
    .filter((b): b is string => !!b)
    .map(normaliseText);
  const ours = brandWords(part.brand);
  for (const b of new Set(brands)) {
    const flat = b.replace(/[^a-z0-9]/g, '');
    if (PLACEHOLDER_BRAND.test(b)) problems.push(`The brand is given as "${b}", not ${part.brand}.`);
    else if (!ours.some((w) => flat.includes(w))) problems.push(`The brand is given as "${b}", not ${part.brand}.`);
  }

  // MPN or model naming a different model of the same family (DCF911B on a DCF921B part). The part,
  // its twin, or a longer form of the same number (PCL206K1, DCS391BR) does not lower it.
  const ownParts = models.map(modelParts).filter((p): p is { letters: string; digits: string } => p !== null);
  const modelValues = [
    ...(listing.mpn ? [listing.mpn] : []),
    ...listing.aspects.filter((a) => MODEL_ASPECTS.has(normaliseText(a.name))).map((a) => a.value),
  ];
  const odd = new Set<string>();
  for (const v of modelValues) {
    for (const tok of normaliseText(v).match(/[a-z]{2,5}\d{2,}[a-z0-9]*/g) ?? []) {
      const p = modelParts(tok);
      if (p && ownParts.some((o) => o.letters === p.letters && o.digits !== p.digits)) odd.add(tok);
    }
  }
  for (const tok of odd) problems.push(`The item specifics name ${tok.toUpperCase()}, a different model.`);

  // v1|<item>|<variation>: a listing of several variations, whose price and sales are for any of them.
  const variation = listing.itemId.split('|')[2];
  if (variation !== undefined && variation !== '0') problems.push('The listing sells several variations; this one may not be the part.');

  // A kit whose title states a different battery count ("w/ 1 Li-Ion Battery" for a two-battery kit).
  const want = kitBatteryCount(part.title);
  const said = statedBatteryCount(title);
  if (want !== null && said !== null && want !== said) {
    problems.push(`The title says ${said} batter${said === 1 ? 'y' : 'ies'}; the part's name says ${want}.`);
  }
  problems.push(...bundleProblems(input));
  return problems;
}

/** "w/2 Li-Ion Batteries", "(2) Batteries", "3 Batteries"; not "6 Ah Battery" or "20V Battery". */
const BATTERY_COUNT = /(?<![\d.])([1-9])(?!\s*(ah|v|volt|amp)\b)(?:\)\s*|\s+|x\s*)(?:[a-z0-9.\-+/]+\s+){0,2}?batter(y|ies)\b/;

function statedBatteryCount(text: string): number | null {
  const m = text.replace(/w\//g, 'w/ ').match(BATTERY_COUNT);
  return m ? Number(m[1]) : null;
}

/**
 * How many batteries a kit's name says it has: "(2) 20V 1.3Ah Batteries" is 2, "(1) Compact Battery
 * and (2) 4.0 Ah Batteries" 3, "Compact Battery, 4.0 Ah Battery" 2, "6 Ah Battery, 20V 6 Ah and
 * 4 Ah Batteries" 3. Null for a name that is not a kit or names no battery.
 */
export function kitBatteryCount(partTitle: string | undefined): number | null {
  const name = normaliseText(partTitle ?? '');
  if (!/\bkit\b|\bcombo\b/.test(name) || !/\bbatter(y|ies)\b/.test(name)) return null;
  const counted = [...name.matchAll(/\((\d)\)\s*(?:\S+\s+){0,3}?batter(y|ies)\b/g)].reduce((n, m) => n + Number(m[1]), 0);
  if (counted > 0) return counted;
  const singular = (name.match(/\bbattery\b/g) ?? []).length;
  const ah = (name.match(/\d+(\.\d+)?\s*ah\b/g) ?? []).length;
  const n = Math.max(singular, ah);
  return n > 0 ? n : null;
}

/** What a part's name says the product is or includes, among the words a bundle adds. */
const BUNDLE_WORDS: [string, RegExp][] = [
  ['battery', /(?<!\bcordless )\bbatter(y|ies)\b(?![- ]?(power|powered|operated|tool|platform|system))/],
  ['charger', /\bchargers?\b/],
  ['kit', /\bkit\b|\bcombo\b|\bbundle\b/],
  ['bag', /\b(carry|carrying|tool|contractor|storage) bag\b/],
];

/**
 * A title naming something the product neither is nor includes: a battery or charger with a
 * tool-only product ("… Impact Driver & 1.5 Ah Battery"), a kit around a charger ("Glue Gun with
 * Battery and PCG002 Charger"), a carry bag with a sander. Negated mentions ("No Battery",
 * "Battery Not Included") and kit-pull phrasing ("from a kit") do not count.
 */
function bundleProblems(input: JudgeInput): string[] {
  const name = normaliseText(input.part.title ?? '');
  if (name === '') return [];
  const title = normaliseText(input.listing.title).replace(NEGATED, ' ').replace(KIT_PULL, ' ').replace(NO_WORD, ' ');
  const out: string[] = [];
  for (const [word, re] of BUNDLE_WORDS) {
    const inName = word === 'bag' ? /\bbags?\b/.test(name) : re.test(name) || (word === 'battery' && /\bbatter(y|ies)\b/.test(name));
    if (inName) continue;
    const m = title.match(re);
    if (m) out.push(`The title names "${m[0]}", which the part's name does not include.`);
  }
  // A tool-only product whose item specifics say a battery or a charger is included: "Set Includes:
  // Reciprocating Saw, Blade, Battery, Charger" (PCL515B 318915722907). "Set Includes: Battery" alone
  // is not used: it sits on labelled matches too (PCL235 147276605796), a template sellers leave in.
  if (/\btools? only\b/.test(name)) {
    for (const a of input.listing.aspects) {
      const key = normaliseText(a.name);
      const val = normaliseText(a.value).replace(NEGATED, ' ');
      const says =
        ((key === 'battery included' || key === 'charger included') && /^yes\b/.test(val)) ||
        (/^(set includes|included components|items included|includes)$/.test(key) && /\bchargers?\b/.test(val));
      if (says) out.push(`The item specifics say "${a.name}: ${a.value}" for a tool-only product.`);
    }
  }
  return out;
}

const unsure = (claimed: VerifiedJudgement['claimed'], raw: JudgeRaw | null, downgrades: string[]): VerifiedJudgement => ({
  verdict: 'unsure',
  claimed,
  raw,
  downgrades,
});

/**
 * Verifies a judge's answer against the listing it was about. `answer` is the model's text (JSON) or
 * an already parsed value. Returns the verdict the scan may use, and why it was lowered if it was.
 */
export function verifyJudgement(answer: unknown, input: JudgeInput): VerifiedJudgement {
  let value = answer;
  if (typeof answer === 'string') {
    try {
      value = JSON.parse(answer);
    } catch {
      return unsure(null, null, ['The judge’s answer is not valid JSON.']);
    }
  }
  const parsed = parseJudgeRaw(value);
  if (!parsed.ok) return unsure(null, null, [parsed.problem]);
  const raw = parsed.raw;
  if (raw.verdict === 'unsure') return { verdict: 'unsure', claimed: 'unsure', raw, downgrades: [] };

  const downgrades: string[] = [];
  const sources = quoteSources(input);
  if (raw.evidence.length === 0) downgrades.push('The judge gave no quote from the listing.');
  for (const { quote } of raw.evidence) {
    const q = normaliseText(quote);
    if (q === '') downgrades.push('The judge gave an empty quote.');
    else if (!sources.some((s) => s.includes(q))) downgrades.push(`The quote "${quote.trim()}" is not found in the listing.`);
  }

  if (raw.verdict === 'match') {
    const { part, listing } = input;
    const models = [part.model, ...(part.twin ? [part.twin] : [])].filter((m) => m.trim() !== '');
    // A quote cut short before "not included" does not count, as identity or as contents.
    const counted = raw.evidence.filter((e) => !((e.claim === 'identity' || e.claim === 'contents') && isCutBeforeNegation(e.quote, sources)));
    for (const e of raw.evidence) {
      if (!counted.includes(e)) downgrades.push(`The quote "${e.quote.trim()}" stops before the listing says it is not included.`);
    }
    const identities = counted.filter((e) => e.claim === 'identity').map((e) => normaliseText(e.quote));
    const naming = identities.filter((q) => models.some((m) => findModel(q, m) >= 0));
    if (naming.length === 0) downgrades.push(`No identity quote contains ${models.join(' or ')}.`);

    const contents = counted.filter((e) => e.claim === 'contents').map((e) => normaliseText(e.quote).replace(NEGATED, ' '));
    const components = namedComponents(part.title);
    // Ruling (fix round 2): a listing that names the exact kit model, not as where a tool was pulled
    // from, and denies none of the kit's pieces, sells the kit: the model number stands for its
    // contents. contentsMatch must still be true and nothing missing.
    const kitByModel =
      components.length > 0 &&
      naming.some((q) => !KIT_PULL.test(q)) &&
      !raw.evidence.some((e) => e.claim === 'missing') &&
      deniesComponents(input, components) === null;
    if (contents.length === 0) {
      downgrades.push(
        part.title
          ? 'No contents quote shows what the listing includes.'
          : 'No part name was given, and no contents quote shows what the listing includes.',
      );
    } else if (!kitByModel) {
      for (const [word, re] of COMPONENTS) {
        if (!components.includes(word)) continue;
        if (!contents.some((q) => re.test(q))) downgrades.push(`The part's name includes a ${word}, and no contents quote names one.`);
      }
    }
    if (raw.contentsMatch !== true) downgrades.push('The judge does not say the listing holds exactly what the product includes.');
    if (raw.quantity !== 1) downgrades.push(`The judge gives the quantity as ${raw.quantity ?? 'unknown'}, not 1.`);
    if (raw.condition !== 'new') downgrades.push(`The judge gives the condition as ${raw.condition ?? 'unknown'}, not new.`);
    if (raw.extras.length > 0) downgrades.push(`The judge lists something sold beyond the product: ${raw.extras.join(', ')}.`);
    if (raw.missing.length > 0) downgrades.push(`The judge lists something the product includes that is missing: ${raw.missing.join(', ')}.`);
    for (const e of raw.evidence) {
      if (e.claim === 'extra') downgrades.push(`The judge quotes something added to the product: "${e.quote.trim()}".`);
      if (e.claim === 'missing') downgrades.push(`The judge quotes something missing from the product: "${e.quote.trim()}".`);
      if (e.claim === 'not_the_product') downgrades.push(`The judge quotes text showing it is not the product: "${e.quote.trim()}".`);
    }
    if (listing.conditionId != null && listing.conditionId !== EBAY_NEW) {
      downgrades.push(`eBay lists the condition as ${listing.conditionId}, not New (${EBAY_NEW}).`);
    }
    downgrades.push(...listingProblems(input, models));
  }

  return downgrades.length > 0 ? unsure(raw.verdict, raw, downgrades) : { verdict: raw.verdict, claimed: raw.verdict, raw, downgrades: [] };
}

/**
 * Judges one listing and verifies the answer. A failed call is `not_judged` and carries no verdict;
 * it never throws, so one listing cannot stop a scan.
 */
export async function judgeListing(judge: ListingJudge, input: JudgeInput, signal?: AbortSignal): Promise<JudgeOutcome> {
  const base = { itemId: input.listing.itemId, judgeId: judge.id, model: judge.model };
  let call;
  try {
    call = await judge.judge(input, signal);
  } catch {
    return { ...base, promptVersion: PROMPT_VERSION, kind: 'not_judged', reason: 'bad_response', message: 'The judge failed without an answer.' };
  }
  const { judgeId, model, promptVersion } = call;
  if (!call.ok) {
    return { ...base, judgeId, model, promptVersion, kind: 'not_judged', ...call.notJudged, ...(call.usage ? { usage: call.usage } : {}) };
  }
  return { ...base, judgeId, model, promptVersion, kind: 'judged', ...verifyJudgement(call.answer, input), usage: call.usage };
}
