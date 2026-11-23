// The code-side check of a model's brief (CLAUDE.md rule 4: never guess). The model explains a suggestion the app already
// holds; it may not add to it. A sentence is kept only when
//   - it cites a quote that exists (quoteIndex), or, for a check, may cite none;
//   - it fits its length and holds none of the words that belong to the app's insides ("quote 2", "verified", "JSON");
//   - every model number, price and count in it appears in the quote it cites, the question or the proposed answer
//     (or in a sentence the code wrote about the suggestion), so a model cannot bring in a part, a price or a number of
//     batteries from its own memory.
// A brief with no surviving reason is the rules brief. The brief never touches the answer, its status or Autopilot:
// `state` and the proposed answer are copied from the input, which the code built.

import { familiesOf, whyKindRefused } from './kinds';
import { cutText, MAX_CHECK_CHARS, MAX_REASON_CHARS, MAX_REASONS, rulesBrief, rulesCheck } from './rules';
import type { BriefCheck, BriefInput, BriefQuote, BriefReason, BriefVerdict, ReviewBrief } from './types';

/** What the model gives back, read (parseBriefRaw) but not yet trusted. */
export interface RawBrief {
  suggestion: string | null;
  reasons: { text: string; quoteIndex: number }[];
  check: { text: string; quoteIndex: number | null } | null;
}

/** The suggestion is "<MODEL> <what it is> + <MODEL> <what it is>": short enough for one line of the card. */
export const MAX_SUGGESTION_CHARS = 70;

/** A model number as the repo reads one: one to five letters, a digit, then letters, digits and hyphens. Run on upper-case text. */
export const MODEL_LIKE = /[A-Z]{1,5}\d[A-Z0-9-]*/g;

/** The model-like tokens of a text, upper-cased, trailing hyphens cut, each hyphenated one also by its parts ("PCL1600K2-PBP2003" gives the pair as well). */
export function modelTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.toUpperCase().matchAll(MODEL_LIKE)) {
    const token = m[0].replace(/-+$/, '');
    out.add(token);
    for (const part of token.split('-')) if (new RegExp(`^${MODEL_LIKE.source}$`).test(part)) out.add(part);
  }
  return [...out];
}

const NUMBER_WORDS: Record<string, string> = {
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
};

/** The numbers a text states (a price, a count, a size), as plain digits, model numbers left out. Number words count ("two-pack" is 2). */
export function numbersOf(text: string): string[] {
  const t = text.toUpperCase().replace(MODEL_LIKE, ' ').toLowerCase().replace(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (w) => ` ${NUMBER_WORDS[w]} `);
  const out = new Set<string>();
  for (const m of t.matchAll(/\d+(?:[.,]\d+)*/g)) out.add(String(Number(m[0].replace(/,/g, ''))));
  return [...out];
}

/** The model numbers and numbers of `text` that none of `corpus` has. */
export function inventedIn(text: string, corpus: readonly string[]): { models: string[]; numbers: string[] } {
  const joined = corpus.join('\n');
  const known = new Set(modelTokens(joined));
  const knownNumbers = new Set(numbersOf(joined));
  return { models: modelTokens(text).filter((t) => !known.has(t)), numbers: numbersOf(text).filter((n) => !knownNumbers.has(n)) };
}

/** Words that belong to the app's insides or overclaim: never in a sentence the owner reads. */
const NOT_FOR_THE_OWNER =
  /\[\d+\]|\bquote\s*#?\d|\bquotes?\s+(?:index|number)|quoteIndex|\bverif|\bprompts?\b|\bschema\b|\bjson\b|\bllm\b|\btokens?\b|\bevidence\b|\bthe model\b|\bguarantee|\bdefinitely\b|\bcertainly\b|\bproves?\b|\bproof\b|100\s?%/i;

/** Why a sentence of a brief cannot be shown, or null when it can. `corpus` is everything it may rest on. */
export function whyNot(text: string, max: number, corpus: readonly string[]): string | null {
  const t = text.trim();
  if (t === '') return 'It is empty.';
  if (t.length > max) return `It is ${t.length} characters; at most ${max}.`;
  const words = NOT_FOR_THE_OWNER.exec(t);
  if (words) return `It uses a word that is not for the owner ("${words[0]}").`;
  const invented = inventedIn(t, corpus);
  if (invented.models.length > 0) return `It names ${invented.models.join(', ')}, which is in neither the quote, the question nor the answer.`;
  if (invented.numbers.length > 0) return `It says ${invented.numbers.join(', ')}, which is in neither the quote, the question nor the answer.`;
  return null;
}

/** What the code knows about the question itself, as text a sentence may rest on. */
export function questionCorpus(input: BriefInput): string[] {
  return [input.ask, input.brand, input.model, input.title ?? '', input.note, ...input.options, input.proposed ?? '', ...input.verdict];
}

const linkOf = (q: BriefQuote): { url?: string; sourceLabel: string } => ({ sourceLabel: q.label, ...(q.url ? { url: q.url } : {}) });

/**
 * Keeps what passes. The brief is the model's when at least one reason survives, otherwise the rules brief (`usable` false).
 * Everything that is not a sentence (the state, the proposed answer's models, every url, every quote text) comes from the
 * input, never from the model.
 */
export function groundBrief(raw: RawBrief, input: BriefInput): { brief: ReviewBrief; verdicts: BriefVerdict[]; usable: boolean } {
  const verdicts: BriefVerdict[] = [];
  const base = questionCorpus(input);
  const last = input.kind === 'split' ? (input.proposedModels[input.proposedModels.length - 1] ?? null) : null;
  const kindProblem = (text: string, corpus: readonly string[]): string | null => whyKindRefused(text, input.proposedModels, last, input.title, familiesOf(corpus.join('\n')));
  const quoteAt = (i: number | null): BriefQuote | undefined => (i !== null && Number.isInteger(i) ? input.quotes[i - 1] : undefined);

  const reasons: BriefReason[] = [];
  const said = new Set<string>();
  for (const r of raw.reasons) {
    const note = (kept: boolean, why?: string): void => void verdicts.push({ part: 'reason', text: r.text, kept, ...(why ? { why } : {}) });
    const q = quoteAt(r.quoteIndex);
    if (!q) { note(false, `It cites quote ${String(r.quoteIndex)}, and there is no such quote.`); continue; }
    const problem = whyNot(r.text, MAX_REASON_CHARS, [q.text, ...base]) ?? kindProblem(r.text, [q.text, ...base]);
    if (problem) { note(false, problem); continue; }
    const key = r.text.trim().toLowerCase();
    if (said.has(key)) { note(false, 'Another reason says the same.'); continue; }
    if (reasons.length >= MAX_REASONS) { note(false, `More than ${MAX_REASONS} reasons.`); continue; }
    said.add(key);
    reasons.push({ text: r.text.trim(), quote: q.text, ...linkOf(q) });
    note(true);
  }

  if (reasons.length === 0) {
    const rules = rulesBrief(input);
    return { brief: rules, verdicts, usable: false };
  }

  // The suggestion in words: kept only when it names every model of the proposed answer and brings none of its own.
  let suggestion = input.proposed;
  if (raw.suggestion !== null && input.proposed !== null && input.proposedModels.length > 0) {
    const text = raw.suggestion.trim();
    const have = new Set(modelTokens(text));
    const missing = input.proposedModels.filter((m) => !modelTokens(m).every((t) => have.has(t)));
    const corpus = [...input.quotes.map((q) => q.text), ...base];
    // One segment per part, each opening with the part's model number: "<MODEL> <what it is> + <MODEL> <what it is>".
    const segments = text.split(/\s\+\s/);
    const bare = segments.find((seg) => !input.proposedModels.some((m) => seg.toUpperCase().includes(m.toUpperCase())));
    const why = missing.length > 0 ? `It leaves out ${missing.join(', ')}, which the answer names.`
      : input.kind === 'split' && (bare !== undefined || segments.length > input.proposedModels.length) ? 'It is not one "<model> <what it is>" per part.'
        : whyNot(text, MAX_SUGGESTION_CHARS, corpus) ?? kindProblem(text, corpus);
    verdicts.push({ part: 'suggestion', text, kept: why === null, ...(why ? { why } : {}) });
    if (why === null) suggestion = text;
  }

  // The check: kept when it passes; otherwise the rules' own check. It may cite a quote, whose link it then takes.
  let check: BriefCheck | null = rulesCheck(input);
  if (raw.check) {
    const q = quoteAt(raw.check.quoteIndex);
    // A check without a quote to point at is not carried: the rules' check says where to look.
    const problem = q ? whyNot(raw.check.text, MAX_CHECK_CHARS, [q.text, ...base]) ?? kindProblem(raw.check.text, [q.text, ...base]) : 'It cites no quote.';
    verdicts.push({ part: 'check', text: raw.check.text, kept: problem === null, ...(problem ? { why: problem } : {}) });
    if (problem === null && q) {
      const link = q.url ? { url: q.url, linkLabel: q.label } : input.checkLink ? { url: input.checkLink.url, linkLabel: input.checkLink.label } : null;
      check = { text: cutText(raw.check.text, MAX_CHECK_CHARS), ...(link ?? {}) };
    }
  }

  return { brief: { ask: input.ask, suggestion, state: input.state, reasons, check, writtenBy: 'ai' }, verdicts, usable: true };
}
