// The code-side check of a judge's answer. The model's word alone never makes a match: every quote
// must be found in the listing, a match must quote the model number and what the listing includes,
// and every field must say one New unit of exactly the product, nothing added and nothing missing. Anything short of that is unsure (CLAUDE.md rule 4). Checks here only ever lower a
// verdict, never raise one.

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

const ACCESSORY_WORD = /\b(for|fits|compatible)\b/;
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

/**
 * Title checks for a match, from the hard cases on eBay's searches: "Hard Case for RYOBI … PCL206B",
 * "Toolbox Insert for PCL206B", "2 Pk … BIT HOLDER - MODEL PCL206B", "2Pack … Battery Compatible
 * with DeWalt … DCB205". A count the part's own name states ("65-Piece" for A986501, "(2-Pack)" for
 * PBP2003) is the product, not several units. Each check only lowers.
 */
function titleProblems(input: JudgeInput, models: string[]): string[] {
  const title = normaliseText(input.listing.title);
  const firstModel = Math.min(...models.map((m) => findModel(title, m)).map((i) => (i < 0 ? Infinity : i)));
  const before = Number.isFinite(firstModel) ? title.slice(0, firstModel) : title;
  const problems: string[] = [];
  const accessory = before.match(ACCESSORY_WORD);
  if (accessory) {
    problems.push(`The title says "${accessory[0]}" before the model number, as accessories do (a case or holder for the product).`);
  }
  const own = new Set(packCounts(normaliseText(input.part.title ?? '')).map((c) => c.key));
  for (const count of packCounts(title)) {
    if (!own.has(count.key)) problems.push(`The title says "${count.said}", which may mean more than one unit.`);
  }
  const included = namedComponents(input.part.title);
  for (const m of title.matchAll(NO_WORD)) {
    const word = m[2]!;
    const isComponent = COMPONENTS.find(([, re]) => re.test(word));
    if (PACKAGING_OR_POWER.has(word) && !(isComponent && included.includes(isComponent[0]))) continue;
    problems.push(`The title says "${m[0]}", which may mean a piece the product includes is missing.`);
  }
  return problems;
}

// "No Blades" (PCL500B 156329863486, a saw sold with a blade) says a piece is missing. "No Box",
// "No Battery" or "No Charger" on a tool-only product do not, unless the product includes it.
const NO_WORD = /\b(no|without|w\/o)\s+([a-z]+)/g;
const PACKAGING_OR_POWER = new Set(['box', 'retail', 'packaging', 'package', 'tag', 'tags', 'battery', 'batteries', 'charger', 'chargers']);

// A component named only to say it is absent ("no charger", "battery not included") is not named.
const NEGATED = new RegExp(
  String.raw`\b(no|without|w/o)\s+(\S+\s+){0,2}?(batter(y|ies)|chargers?|bags?|cases?)\b|(batter(y|ies)|chargers?|bags?|cases?)\s+(\S+\s+){0,2}?(not included|sold separately)`,
  'g',
);

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
    const named = raw.evidence.some(
      (e) => e.claim === 'identity' && models.some((m) => findModel(normaliseText(e.quote), m) >= 0),
    );
    if (!named) downgrades.push(`No identity quote contains ${models.join(' or ')}.`);
    const contents = raw.evidence.filter((e) => e.claim === 'contents').map((e) => normaliseText(e.quote).replace(NEGATED, ' '));
    if (contents.length === 0) {
      downgrades.push(
        part.title
          ? 'No contents quote shows what the listing includes.'
          : 'No part name was given, and no contents quote shows what the listing includes.',
      );
    } else {
      for (const [word, re] of COMPONENTS) {
        if (!namedComponents(part.title).includes(word)) continue;
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
    downgrades.push(...titleProblems(input, models));
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
