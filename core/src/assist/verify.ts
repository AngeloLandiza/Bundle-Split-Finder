// The code-side check of the review assistant's answer. The model's word alone never makes a verified
// suggestion: every quote must be found, word for word, in one line of the source it names; the
// answer must be one the question offers; and a choice must be shown by quotes that name it. Anything
// short of that is unverified, which the panel shows without preselecting anything (CLAUDE.md rule 4).
// Verified means only that the suggestion is grounded in the stored pages: the owner still decides.
// Quotes are compared as the listing judge compares them (normaliseText, findModel in judge/verify.ts).

import { findModel, normaliseText } from '../judge/verify';
import { modelForms } from '../match';
import { choicesOf } from '../scan/answers';
import type { ReviewItem } from '../scan/types';
import { parseAssistRaw } from './schema';
import type { AssistEvidence, AssistRaw, CheckedSuggestion, EvidenceSource, SuggestedAnswer, VerifiedQuote } from './types';

/** The model's reason is shown to the owner; longer than this it is cut. */
export const MAX_REASON_CHARS = 300;

/** A listing title that sells something for the part, not the part (the listing judge's ACCESSORY_BEFORE_MODEL words). */
const ACCESSORY_BEFORE_MODEL = /\b(for|fits|compatible|replacement)\b/;
/** A listing title that is not New. */
const NOT_NEW = /\b(renewed|refurbished|reconditioned|used|open[- ]box|pre-?owned)\b/;

const cut = (s: string): string => (s.length > MAX_REASON_CHARS ? `${s.slice(0, MAX_REASON_CHARS - 1)}…` : s);
const show = (q: string): string => {
  const t = q.trim().replace(/\s+/g, ' ');
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};

/** Where a quote was found: its source and line, or why it was not. */
type Found = { ok: true; source: EvidenceSource; line: string } | { ok: false; problem: string };

function findQuote(quote: string, sourceId: string, evidence: AssistEvidence): Found {
  const source = evidence.sources.find((s) => s.id === sourceId.trim());
  if (!source) return { ok: false, problem: `The quote "${show(quote)}" names a source that was not given (${show(sourceId)}).` };
  const q = normaliseText(quote);
  if (q === '') return { ok: false, problem: 'The answer gave an empty quote.' };
  const lines = source.lines.filter((l) => normaliseText(l.text).includes(q));
  if (lines.length === 0) return { ok: false, problem: `The quote "${show(quote)}" is not found in the ${source.label}.` };
  if (lines.every((l) => l.suspect)) {
    return { ok: false, problem: `The quote "${show(quote)}" comes from text written to an AI, which is never evidence.` };
  }
  return { ok: true, source, line: normaliseText(lines.find((l) => !l.suspect)!.text) };
}

/** Whether normalised text names a model, in any way it may be written. */
const names = (text: string, brand: string, model: string): boolean => modelForms(brand, model).some((f) => findModel(text, f) >= 0);

/**
 * Checks a model's answer (its JSON text, or parsed JSON) against the question it was asked and the
 * evidence it was shown. Never raises an answer: it confirms it, or says why it cannot.
 */
export function verifySuggestion(answer: unknown, question: ReviewItem, evidence: AssistEvidence): CheckedSuggestion {
  const parsed = parseAssistRaw(answer);
  if (!parsed.ok) return { status: 'unverified', reasons: [parsed.problem], claimed: null };
  const raw: AssistRaw = parsed.raw;
  const reason = cut(raw.reason.trim());
  if (evidence.questionId !== question.id || evidence.kind !== question.kind) {
    return { status: 'unverified', reasons: ['The evidence is for another question.'], claimed: raw };
  }

  const problems: string[] = [];
  const quotes: (VerifiedQuote & { norm: string })[] = [];
  for (const e of raw.evidence) {
    const found = findQuote(e.quote, e.source, evidence);
    if (!found.ok) {
      problems.push(found.problem);
      continue;
    }
    const norm = normaliseText(e.quote);
    if (quotes.some((q) => q.sourceId === found.source.id && q.norm === norm)) continue;
    quotes.push({ quote: e.quote.trim(), sourceId: found.source.id, label: found.source.label, url: found.source.url, names: false, norm });
  }
  const strip = (qs: typeof quotes): VerifiedQuote[] => qs.map(({ norm: _norm, ...q }) => q);

  if (raw.decision === 'cannot_tell') return { status: 'cannot_tell', reason, quotes: strip(quotes) };

  if (evidence.sources.some((s) => s.lines.some((l) => l.suspect))) {
    problems.push('The page holds text written to an AI; read it yourself before answering.');
  }

  let suggested: SuggestedAnswer;
  if (raw.decision === 'none') {
    if (quotes.length === 0) problems.push('The answer says none fits, and gives no quote that shows it.');
    suggested = { decision: 'none' };
  } else if (question.kind === 'split') {
    const choices = choicesOf(question);
    const i = raw.choiceIndex;
    if (choices.length === 0) {
      problems.push('The question offers no readings to choose from.');
    } else if (i === null || i < 0 || i >= choices.length) {
      problems.push(`The answer chooses reading ${i ?? 'none'}; the question offers ${choices.length === 1 ? 'only reading 0' : `readings 0 to ${choices.length - 1}`}.`);
    }
    const parts = i !== null && i >= 0 && i < choices.length ? choices[i]! : [];
    // What the bundle holds is shown by the bundle's own page, not a kit's: only its quotes name a part.
    const own = quotes.filter((q) => q.sourceId === 'bundle');
    for (const part of parts) {
      const naming = own.filter((q) => names(q.norm, question.brand, part));
      if (naming.length === 0) problems.push(`No quote from the bundle's page names ${part}.`);
      for (const q of naming) q.names = true;
    }
    suggested = { decision: 'choose', kind: 'split', choiceIndex: i ?? -1, parts: [...parts] };
  } else {
    const asin = (raw.asin ?? '').trim().toUpperCase();
    const candidate = question.candidates.find((c) => c.asin.trim().toUpperCase() === asin);
    if (!candidate) {
      problems.push(asin === '' ? 'The answer chooses a listing and gives no ASIN.' : `The answer chooses ${show(asin)}, which is not one of the listings offered.`);
    } else {
      const id = `listing:${candidate.asin}`;
      const naming = quotes.filter((q) => q.sourceId === id && names(q.norm, question.brand, question.model));
      if (naming.length === 0) problems.push(`No quote from listing ${candidate.asin} names ${question.model}.`);
      for (const q of naming) q.names = true;
      const title = normaliseText(candidate.title);
      const at = Math.min(...modelForms(question.brand, question.model).map((f) => findModel(title, f)).map((n) => (n < 0 ? Infinity : n)));
      const before = Number.isFinite(at) ? title.slice(0, at) : title;
      const accessory = before.match(ACCESSORY_BEFORE_MODEL);
      if (accessory) problems.push(`Listing ${candidate.asin}'s title says "${accessory[0]}" before the model, as accessories and spare parts do.`);
      const used = title.match(NOT_NEW);
      if (used) problems.push(`Listing ${candidate.asin}'s title says "${used[0]}", which is not New.`);
    }
    suggested = { decision: 'choose', kind: 'match', asin: candidate?.asin ?? asin, title: candidate?.title ?? '' };
  }

  if (problems.length > 0) return { status: 'unverified', reasons: problems, claimed: raw };
  // The quotes that name the answer first: the panel shows at most three.
  const ordered = [...quotes.filter((q) => q.names), ...quotes.filter((q) => !q.names)];
  return { status: 'verified', answer: suggested, quotes: strip(ordered), reason };
}
