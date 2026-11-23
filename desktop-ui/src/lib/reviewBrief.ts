// The decision card's text for a Review question, derived by rules when the agent sent no `brief` (api/types.ts
// ReviewBrief). The card shows one fixed schema: what is asked, the suggestion in plain words, at most three reasons, the
// one thing to check. Everything else stays in the pane's Details. Pure; Review only draws it.
//
// Rule 4 (never guess): the suggestion is the AI's own reading and nothing else; "what each part is" (kit, tool, battery,
// charger) comes only from words already in the data (a catalog quote "RYOBI PCL1600K2 (kit): ...", or the AI's own
// reason right after the model); a part with neither is named by its model alone. A reason is the AI's own sentence cut
// at a clause, never reworded; the full text is in Details.

import type { AiSuggestion, QuestionKind, ReviewBrief, ReviewQuestion } from '../api/types';
import { plainReason } from './questionWords';

/** A card line is never longer than this. */
export const BRIEF_LINE_MAX = 110;
/** At most this many reasons on the card. */
export const BRIEF_REASONS_MAX = 3;

const ASK: Record<QuestionKind, string> = {
  split: 'What is inside this bundle?',
  match: 'Which Amazon listing is this part?',
  ebay: 'Is this the same item on eBay?',
};

/** The card's question, one short line, by kind. */
export const askOf = (kind: QuestionKind): string => ASK[kind];

const collapse = (t: string): string => t.replace(/\s+/g, ' ').trim();
const upFirst = (t: string): string => (t ? t[0]!.toUpperCase() + t.slice(1) : t);

/**
 * Where a long line may end: a boundary between two whole claims. A bare comma is not one (it also separates the items of
 * a list, and "the 65-piece drill and impact drive kit" is not "the 65-piece drill"), so those lines end at a word instead.
 */
const CLAUSE_BREAKS = [';', ' — ', ', and ', ', but ', ', so ', ', which ', ' but ', ' which ', ' so ', ' because '];
/** Words a line must not end on before its ellipsis. */
const DANGLING = /\s+(?:the|a|an|of|in|to|and|or|for|on|with|by|as|is|are|its|from|that|at)$/i;

/**
 * One line of at most `max` characters: the text itself when it fits; else without its parentheticals when that fits;
 * else it ends at the last claim boundary that keeps at least 60 characters (a full stop closes it); else at a word with
 * an ellipsis. Nothing is added or reworded; the whole text stays in Details.
 */
export function shortLine(text: string, max = BRIEF_LINE_MAX): string {
  const t = collapse(text);
  if (t.length <= max) return t;
  // A parenthetical is the first thing to go: "(PCL1600K2 + PBP2003)" repeats what the card already says.
  const bare = t.replace(/\s*\([^)]*\)/g, '');
  if (bare !== t && bare.length <= max) return bare;
  const u = bare.length < t.length ? bare : t;
  let at = -1;
  for (const b of CLAUSE_BREAKS) {
    const i = u.lastIndexOf(b, max - 1);
    if (i >= 60 && i > at) at = i;
  }
  if (at > 0) return `${u.slice(0, at).replace(/[,;:\s]+$/, '')}.`;
  let cut = u.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  if (sp > 20) cut = cut.slice(0, sp);
  cut = cut.replace(/[,;:\s]+$/, '');
  while (DANGLING.test(cut)) cut = cut.replace(DANGLING, '').replace(/[,;:\s]+$/, '');
  return `${cut}…`;
}

/**
 * The sentences of a text. A full stop ends one only after a word of three or more characters followed by a capital, so
 * "7-1/4 in. Compound Miter Saw" and "2.0 Ah" stay whole.
 */
export function sentencesOf(text: string): string[] {
  return collapse(text)
    .split(/(?<=[A-Za-z0-9)”"']{3}[.!?])\s+(?=[A-Z“"(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The models an answer names: "PCL1600K2 + PBP006" or "PCL1600K2, PBP2003", a quantity mark dropped. */
export function modelsOfAnswer(answer: string): string[] {
  return answer
    .split(/\s*[+,]\s*/)
    .map((p) => p.replace(/\s*[×x]\s*\d+$/i, '').trim())
    .filter(Boolean);
}

type PartKind = 'kit' | 'tool' | 'battery' | 'charger';

/**
 * What a model is, only when the data says so: a catalog quote "RYOBI PCL1600K2 (kit): ..." says kit; the AI's own
 * reason names it after the model ("the PBP2003 two-pack of 2.0 Ah batteries"). Anything else is not said.
 */
function partKind(model: string, reason: string | null, quotes: string[]): PartKind | null {
  const m = esc(model);
  if (quotes.some((t) => new RegExp(`\\b${m}\\s*\\(kit\\)`, 'i').test(t))) return 'kit';
  if (!reason) return null;
  const at = new RegExp(`\\b${m}\\b`, 'i').exec(reason);
  if (!at) return null;
  // The words the AI put right after the model, up to the end of that clause.
  const tail = reason.slice(at.index + model.length, at.index + model.length + 70);
  const clause = tail.split(/[,;]|\.\s+[A-Z]|\.$| and | plus | but | which | that | match /)[0] ?? '';
  if (/\bkit\b/i.test(clause)) return 'kit';
  if (/\bbatter(?:y|ies)\b/i.test(clause)) return 'battery';
  if (/\bcharger\b/i.test(clause)) return 'charger';
  if (/\btool\b/i.test(clause)) return 'tool';
  return null;
}

/** "PCL1600K2 kit + PBP2003 battery": the AI's parts, each with what it is when the data says. */
export function describeParts(answer: string, reason: string | null, quotes: string[]): string {
  return modelsOfAnswer(answer)
    .map((m) => {
      const k = partKind(m, reason, quotes);
      return k ? `${m} ${k}` : m;
    })
    .join(' + ');
}

const HD = 'Home Depot page';

/**
 * What the AI could not tell, in one line. Its reason usually ends in the missing thing ("..., so the exact tool-only model
 * numbers inside it could not be confirmed"), so the line is the last clause when that stands alone; else the sentence cut
 * short as any other. The AI's own words either way; the whole reason is in Details.
 */
function missingLine(reason: string): string {
  const first = sentencesOf(reason)[0] ?? reason;
  for (const sep of [', so ', ', but ', ', and ']) {
    const i = first.lastIndexOf(sep);
    if (i < 0) continue;
    const tail = first.slice(i + sep.length).replace(/\.$/, '').trim();
    if (tail.length >= 25 && tail.length < BRIEF_LINE_MAX) return `${upFirst(tail)}.`;
  }
  return shortLine(first);
}

/** The page a question is about: Home Depot for a split, else the Amazon listing a choice carries. */
function whereOf(q: ReviewQuestion): { url?: string; label: string } {
  if (q.kind === 'split') return q.bundle.link ? { url: q.bundle.link, label: HD } : { label: HD };
  const src = q.choices.find((c) => c.source?.url)?.source ?? null;
  return src?.url ? { url: src.url, label: src.label || 'Amazon listing' } : { label: 'Amazon listing' };
}

/** The source the suggestion rests on: the first quote it gave, else the first line of the question's own evidence. */
function sourceOf(q: ReviewQuestion, s: AiSuggestion | null): { sourceLabel?: string; url?: string } {
  // The first quote with an address of its own, else the first quote: a link he can open beats a plain label.
  const src = s?.quotes.find((x) => x.source.url)?.source ?? s?.quotes[0]?.source ?? q.evidence.find((x) => x.source.url)?.source ?? q.evidence[0]?.source;
  if (!src) return {};
  return { sourceLabel: src.label, ...(src.url ? { url: src.url } : {}) };
}

/**
 * The first unmet thing in plain words, from the agent's own "Not verified: <reason>; <reason>. Check the Home Depot page."
 * sentence. "the page never names DCK240C2" becomes an instruction; any other reason is said as it is.
 */
function firstUnmet(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const body = plain
    .replace(/^Not verified:\s*/i, '')
    .replace(/\s*Check the (?:Home Depot page|Amazon listing)\.?\s*$/i, '')
    .replace(/\.$/, '');
  const clause = body.split(';').map((c) => c.trim()).find((c) => c && !/^\d+ more in Activity$/i.test(c));
  if (!clause) return null;
  const never = /^the page never names (\S+)$/i.exec(clause);
  return shortLine(never ? `Whether the page names ${never[1]}.` : `${upFirst(clause)}.`);
}

/** Under the card's "Check" label, so a thing and not a command: the label already says check it. */
const GENERIC_CHECK: Record<QuestionKind, string> = {
  split: 'What is included in the bundle.',
  match: 'That the listing is this exact model.',
  ebay: 'That it is the same item.',
};

/**
 * The card for a question when the agent sent none. State from the suggestion's status; the suggestion is the AI's reading
 * in plain words or null; the reasons are the AI's own sentence cut short (at most two) and the plain "why it is asked"
 * sentence; the check is the first thing the code did not confirm, with the page to look at.
 */
export function briefFromQuestion(q: ReviewQuestion): ReviewBrief {
  const s = q.suggestion;
  const where = whereOf(q);
  const why = plainReason(q.reason, { brand: q.bundle.brand, model: q.bundle.model });
  const whyLines = sentencesOf(why.text).map((t) => shortLine(t));
  const link = { ...(where.url ? { url: where.url } : {}), sourceLabel: where.label };

  if (!s) {
    // No AI answer: the card says why it is asked and where to look; there is nothing to call a suggestion.
    return {
      ask: askOf(q.kind),
      suggestion: null,
      state: 'none',
      reasons: whyLines.slice(0, 2).map((text) => ({ text, ...link })),
      check: { text: GENERIC_CHECK[q.kind], ...(where.url ? { url: where.url } : {}), linkLabel: where.label },
      writtenBy: 'rules',
    };
  }

  const src = sourceOf(q, s);
  const aiLines = s.reason ? sentencesOf(s.reason).slice(0, 2).map((t) => shortLine(t)) : [];

  if (s.status === 'cannot_tell') {
    return {
      ask: askOf(q.kind),
      suggestion: null,
      state: 'cannot_tell',
      reasons: (s.reason ? [missingLine(s.reason)] : whyLines.slice(0, 1)).map((text) => ({ text, ...src })),
      check: { text: 'Pick the parts below, or open the page.', ...(where.url ? { url: where.url } : {}), linkLabel: where.label },
      writtenBy: 'rules',
    };
  }

  const quoteTexts = [...s.quotes, ...q.evidence].map((x) => x.text);
  const noneFit = s.answer === 'None of these fits';
  const suggestion = noneFit ? 'None of these choices fit' : q.kind === 'split' ? describeParts(s.answer, s.reason, quoteTexts) : (s.answer.split(' · ')[0] ?? s.answer);
  const reasons: ReviewBrief['reasons'] = aiLines.map((text) => ({ text, ...src }));
  if (whyLines[0]) reasons.push({ text: whyLines[0], ...link });

  const verified = s.status === 'verified';
  const unmet = verified ? null : firstUnmet(s.plain);
  return {
    ask: askOf(q.kind),
    suggestion,
    state: verified ? 'verified' : 'not_verified',
    reasons: reasons.slice(0, BRIEF_REASONS_MAX),
    check: verified ? null : { text: unmet ?? GENERIC_CHECK[q.kind], ...(where.url ? { url: where.url } : {}), linkLabel: where.label },
    writtenBy: 'rules',
  };
}

/** The agent's brief when it sent one, else the rules' (a brief of the shape the agent promises is trusted as it is). */
export const briefFor = (q: ReviewQuestion): ReviewBrief => q.brief ?? briefFromQuestion(q);

/** How many parts a split's suggestion names ("2 parts"), or null when it is not a split or names none. */
function partCount(q: ReviewQuestion): number | null {
  const s = q.suggestion;
  if (q.kind !== 'split' || !s || s.status === 'cannot_tell' || s.answer === 'None of these fits') return null;
  const n = modelsOfAnswer(s.answer).length;
  return n > 0 ? n : null;
}

/**
 * The 2 to 4 words a list row says about its question, from the card's state: "Suggested: 2 parts", "Verified: 3 parts",
 * "AI could not tell", "Needs a listing". Never a title.
 */
export function rowState(q: ReviewQuestion, brief: ReviewBrief = briefFor(q)): string {
  const n = partCount(q);
  const noun = q.kind === 'split' ? (n !== null ? `${n} ${n === 1 ? 'part' : 'parts'}` : 'parts') : 'listing';
  switch (brief.state) {
    case 'verified':
      return n !== null || q.kind !== 'split' ? `Verified: ${noun}` : 'Verified';
    case 'not_verified':
      return brief.suggestion === null || q.suggestion?.answer === 'None of these fits' ? 'AI: none fit' : `Suggested: ${noun}`;
    case 'cannot_tell':
      return 'AI could not tell';
    case 'none':
      return q.kind === 'split' ? 'Needs the parts' : q.kind === 'match' ? 'Needs a listing' : 'Needs a check';
  }
}
