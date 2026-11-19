// The code-side check of a judge's answer. The model's word alone never makes a match: every quote
// must be found in the listing, a match must quote the model number, and every field must say one
// bare New tool. Anything short of that is unsure (CLAUDE.md rule 4). Checks here only ever lower a
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
const PACK = /\b\d+\s*-?\s*(pk|pks|pack|packs|pcs|pc|piece|pieces|count|ct|lot)\b|\b(pack|lot|set) of\b/;

/**
 * Title checks for a match, from the hard cases on eBay's PCL206B search: "Hard Case for RYOBI …
 * PCL206B", "Toolbox Insert for PCL206B", "2 Pk … BIT HOLDER - MODEL PCL206B". Each only lowers.
 */
function titleProblems(input: JudgeInput, models: string[]): string[] {
  const title = normaliseText(input.listing.title);
  const firstModel = Math.min(...models.map((m) => findModel(title, m)).map((i) => (i < 0 ? Infinity : i)));
  const before = Number.isFinite(firstModel) ? title.slice(0, firstModel) : title;
  const problems: string[] = [];
  const accessory = before.match(ACCESSORY_WORD);
  if (accessory) {
    problems.push(`The title says "${accessory[0]}" before the model number, as accessories do (a case or holder for the tool).`);
  }
  const pack = title.match(PACK);
  if (pack) problems.push(`The title says "${pack[0]}", which may mean more than one unit.`);
  return problems;
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
    if (raw.toolOnly !== true) downgrades.push('The judge does not say the listing is the bare tool alone.');
    if (raw.quantity !== 1) downgrades.push(`The judge gives the quantity as ${raw.quantity ?? 'unknown'}, not 1.`);
    if (raw.condition !== 'new') downgrades.push(`The judge gives the condition as ${raw.condition ?? 'unknown'}, not new.`);
    if (raw.extras.length > 0) downgrades.push(`The judge lists something sold with the tool: ${raw.extras.join(', ')}.`);
    for (const e of raw.evidence) {
      if (e.claim === 'extra') downgrades.push(`The judge quotes something included besides the tool: "${e.quote.trim()}".`);
      if (e.claim === 'not_the_tool') downgrades.push(`The judge quotes text showing it is not the tool: "${e.quote.trim()}".`);
    }
    if (listing.conditionId !== undefined && listing.conditionId !== EBAY_NEW) {
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
