// What a brief is written from (BriefInput): the question, the proposed answer, and only the quotes the code has already
// found word for word in a stored source, with the code's own sentences about the suggestion. A claim the code could not
// find is not here, so neither a rule nor a model can build a sentence on it.

import { normaliseText } from '../judge/verify';
import { plainReason } from '../assist/plain';
import { proposedAnswer } from '../assist/stored';
import type { AssistEvidence, Suggestion } from '../assist/types';
import { choicesOf, NONE } from '../scan/answers';
import type { ReviewItem } from '../scan/types';
import type { BriefInput, BriefQuote, BriefState } from './types';

/** Quotes a brief may rest on: the most it is shown. */
export const MAX_BRIEF_QUOTES = 6;
/** A quote is shown cut to this many characters (a long Includes line); the cut text is all a sentence may rest on. */
export const MAX_QUOTE_CHARS = 600;
/** A claimed quote shorter than this (normalised) proves nothing by being found. */
const MIN_QUOTE_CHARS = 8;
const MAX_PLAIN_REASONS = 3;

/** One line of a stored source, where a claimed quote may be found. */
export interface PoolLine {
  text: string;
  sourceId: string | null;
  label: string;
  url: string | null;
}

/** The lines of the evidence the assistant was given, minus the lines that read as words written to an AI. */
export function poolOfEvidence(evidence: AssistEvidence): PoolLine[] {
  return evidence.sources.flatMap((s) => s.lines.filter((l) => !l.suspect).map((l) => ({ text: l.text, sourceId: s.id, label: s.label, url: s.url })));
}

/** The lines a Review question stores for its panel (ReviewQuestion.evidence): each with its source's label and link, none with an id. */
export function poolOfLines(lines: readonly { text: string; source: { label: string; url: string | null } }[]): PoolLine[] {
  return lines.map((l) => ({ text: l.text, sourceId: null, label: l.source.label, url: l.source.url }));
}

const cut = (text: string, max: number): string => {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** The quotes a suggestion claims, as written, with the source id each names (null when it names none). */
function claimedQuotes(s: Suggestion): { quote: string; sourceId: string | null }[] {
  if (s.status === 'unverified') {
    const out: { quote: string; sourceId: string | null }[] = [];
    for (const e of s.claimed?.evidence ?? []) out.push({ quote: e.quote, sourceId: e.source });
    const r = s.researchClaim;
    if (r) {
      for (const q of r.quotes) out.push({ quote: q.quote, sourceId: q.sourceId });
      for (const p of r.parts) for (const q of p.quotes) out.push({ quote: q.quote, sourceId: q.sourceId });
    }
    return out;
  }
  return [];
}

const names = (text: string, models: readonly string[]): boolean => {
  const t = normaliseText(text);
  return models.some((m) => m !== '' && t.includes(normaliseText(m)));
};

/**
 * The quotes of a suggestion that the code can stand behind. A verified, cannot-tell or none suggestion already holds
 * the quotes the verifier found. An unverified one holds claims: each is looked for in the pool (the named source
 * first) and only the ones found word for word are kept. The ones that name the proposed answer come first.
 */
export function foundQuotes(s: Suggestion, pool: readonly PoolLine[], models: readonly string[]): BriefQuote[] {
  const found: BriefQuote[] = [];
  const seen = new Set<string>();
  const add = (q: BriefQuote): void => {
    const key = normaliseText(q.text);
    if (key.length < MIN_QUOTE_CHARS || seen.has(key)) return;
    seen.add(key);
    found.push({ ...q, text: cut(q.text, MAX_QUOTE_CHARS) });
  };
  if (s.status === 'verified' || s.status === 'cannot_tell' || s.status === 'none_suggested') {
    for (const q of s.quotes) add({ text: q.quote, sourceId: q.sourceId, label: q.label, url: q.url });
  } else {
    for (const c of claimedQuotes(s)) {
      const q = normaliseText(c.quote);
      if (q.length < MIN_QUOTE_CHARS) continue;
      const lines = pool.filter((l) => normaliseText(l.text).includes(q));
      const line = lines.find((l) => l.sourceId !== null && l.sourceId === c.sourceId?.trim()) ?? lines[0];
      if (line) add({ text: c.quote.trim(), sourceId: line.sourceId, label: line.label, url: line.url });
    }
  }
  return [...found.filter((q) => names(q.text, models)), ...found.filter((q) => !names(q.text, models))].slice(0, MAX_BRIEF_QUOTES);
}

/** The links a question's brief may send the owner to, from the sources its evidence holds. */
export function linksOfEvidence(evidence: AssistEvidence): BriefSourceLink[] {
  return evidence.sources.filter((s) => s.url !== null).map((s) => ({ label: s.label, url: s.url!, source: s.kind === 'listing' ? 'amazon' : 'homedepot' }));
}

const ASKS = { split: 'What is inside this bundle?', match: 'Which Amazon listing is this part?' } as const;

/** "PBP003" twice reads "2 × PBP003". */
function partsInWords(parts: readonly string[]): { text: string; models: string[] } {
  const counts = new Map<string, number>();
  for (const p of parts) counts.set(p, (counts.get(p) ?? 0) + 1);
  const models = [...counts.keys()];
  return { text: models.map((m) => (counts.get(m)! > 1 ? `${counts.get(m)} × ${m}` : m)).join(' + '), models };
}

const capital = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));

const STATE_OF: Record<string, BriefState> = { verified: 'verified', unverified: 'not_verified', none_suggested: 'not_verified', cannot_tell: 'cannot_tell' };

export interface BriefSourceLink {
  label: string;
  url: string;
  source: 'homedepot' | 'amazon' | 'ebay' | 'keepa';
}

/**
 * The input of one question's brief. `suggestion` is the live suggestion for the question as it is now, or null; `pool` is
 * where its claimed quotes are looked for; `sources` are the question's links (Home Depot page, Amazon listings).
 */
export function briefInputOf(question: ReviewItem, suggestion: Suggestion | null, pool: readonly PoolLine[], sources: readonly BriefSourceLink[]): BriefInput {
  const kind = question.kind;
  const shown = suggestion !== null && suggestion.status !== 'not_suggested' ? suggestion : null;
  const answer = shown ? proposedAnswer(shown, question) : null;

  let proposed: string | null = null;
  let proposedModels: string[] = [];
  let proposedAsin: string | null = null;
  if (answer === NONE) proposed = 'None of these fits';
  else if (answer !== null && kind === 'split') ({ text: proposed, models: proposedModels } = partsInWords(answer.split(',').filter((p) => p !== '')));
  else if (answer !== null) {
    const c = question.candidates.find((x) => x.asin === answer);
    proposedAsin = c?.asin ?? null;
    proposed = c ? cut(c.title || c.asin, 110) : null;
    proposedModels = proposed ? [question.model.trim().toUpperCase()] : [];
  }

  const state: BriefState = shown ? (STATE_OF[shown.status] ?? 'none') : 'none';
  const plainReasons: string[] = [];
  const verdict: string[] = [];
  if (shown?.status === 'unverified') {
    // What is wrong with the parts and the page first; how the AI quoted last (it means little to the owner).
    const known = [...new Set(shown.reasons.map(plainReason).filter((p): p is string => p !== null))];
    const aboutQuoting = (p: string): boolean => /\bquote\b|written to an AI|a page it did not read/.test(p);
    for (const p of [...known.filter((x) => !aboutQuoting(x)), ...known.filter(aboutQuoting)].slice(0, MAX_PLAIN_REASONS)) plainReasons.push(`${capital(p)}.`);
    verdict.push(...(plainReasons.length > 0 ? plainReasons : ["The app's checks did not confirm the AI's answer."]));
  } else if (shown?.status === 'verified') verdict.push('The app found every quote below word for word on its page and checked the answer against them.');
  else if (shown?.status === 'cannot_tell') verdict.push('The AI said the pages the app holds do not settle it.');
  else if (shown?.status === 'none_suggested') verdict.push('The AI thought none of the options fits; the app cannot confirm that.');

  const link = kind === 'split'
    ? sources.find((s) => s.source === 'homedepot')
    : sources.find((s) => s.source === 'amazon' && proposedAsin !== null && s.url.includes(proposedAsin)) ?? sources.find((s) => s.source === 'amazon');
  const checkLink = link ? { url: link.url, label: link.source === 'homedepot' ? 'Home Depot page' : 'Amazon listing' } : null;

  return {
    questionId: question.id, kind, ask: ASKS[kind], brand: question.brand, model: question.model, title: question.title, note: question.reason,
    options: kind === 'split' ? choicesOf(question).map((p) => p.join(', ')) : question.candidates.map((c) => `${c.asin}: ${c.title}`),
    state, proposed, proposedModels, verdict, plainReasons,
    quotes: shown ? foundQuotes(shown, pool, proposedModels) : [],
    checkLink,
  };
}
