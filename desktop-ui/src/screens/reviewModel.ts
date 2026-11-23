import { isWorking, type AiSuggestion, type DealSection, type FollowUpStep, type Grade, type QuestionKind, type Quote, type ReviewQuestion, type Source } from '../api/types';

/** How many of what the app checked show on the card; the rest are in Details. */
export const CHECKED_VISIBLE = 3;

/** What the card shows of what the app did, and what is left for Details. */
export function checkedLines(tried: FollowUpStep[]): { shown: FollowUpStep[]; rest: FollowUpStep[] } {
  return { shown: tried.slice(0, CHECKED_VISIBLE), rest: tried.slice(CHECKED_VISIBLE) };
}

/** How many confirmed parts show on the card; the rest are in Details. */
export const SETTLED_VISIBLE = 3;

export function settledLines<T>(parts: T[]): { shown: T[]; rest: T[] } {
  return { shown: parts.slice(0, SETTLED_VISIBLE), rest: parts.slice(SETTLED_VISIBLE) };
}

const modelKey = (m: string) => m.trim().toUpperCase();

/** The question's models Home Depot's pages confirmed, as a set to ask of a reading's models. Empty when the agent sent none. */
export function settledModelSet(q: Pick<ReviewQuestion, 'settledParts'>): Set<string> {
  return new Set((q.settledParts ?? []).map((p) => modelKey(p.model)));
}

/**
 * Whether a choice's models are marked: only when the agent said some parts are settled, and then each model on its own
 * (settled: confirmed by Home Depot's page; not settled: no mark).
 */
export function modelMarks(q: Pick<ReviewQuestion, 'settledParts'>, models: string[]): { model: string; settled: boolean }[] | null {
  const set = settledModelSet(q);
  if (set.size === 0 || models.length === 0) return null;
  return models.map((model) => ({ model, settled: set.has(modelKey(model)) }));
}

/** A source link's label from its address when the step names none: "Home Depot", "Amazon", else the host. */
export function stepSource(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.endsWith('homedepot.com')) return 'Home Depot';
    if (host.endsWith('amazon.com')) return 'Amazon';
    return host;
  } catch {
    return 'Source';
  }
}

/** How long the "Saved · Undo" row stays at the top of Review. */
export const SAVED_ROW_MS = 8000;

export const KIND_LABEL: Record<QuestionKind, string> = {
  split: 'Which parts',
  match: 'Which listing',
  ebay: 'eBay listing',
};

export const SECTION_LABEL: Record<DealSection, string> = {
  confirmed: 'Confirmed',
  waiting: 'Waiting for lookup',
  inactive_listing: 'Inactive listing',
  missing_listing: 'Missing listing',
  split: 'Contents not known',
};

export const SECTION_ORDER: readonly DealSection[] = ['confirmed', 'waiting', 'inactive_listing', 'missing_listing', 'split'];

export const GRADE_LABEL: Record<Grade, string> = {
  verified: 'Verified',
  title_match: 'Title match',
  needs_answer: 'Needs your answer',
  inactive: 'Listing inactive',
  missing: 'No listing found',
  not_looked_up: 'Not looked up yet',
};

/**
 * Review's groups: AI-verified suggestions (one press approves them), the rest, which need him, and the questions the app
 * is still working on itself (queued or running), which are not his yet and are kept apart, collapsed.
 */
export function groupQuestions(questions: ReviewQuestion[]): { verified: ReviewQuestion[]; needsYou: ReviewQuestion[]; working: ReviewQuestion[] } {
  const working = questions.filter((q) => isWorking(q.followUp));
  const rest = questions.filter((q) => !isWorking(q.followUp));
  const verified = rest.filter((q) => q.suggestion?.status === 'verified');
  const needsYou = rest.filter((q) => q.suggestion?.status !== 'verified');
  return { verified, needsYou, working };
}

/** What the section of working questions says: "The app is still working on 3". */
export const workingTitle = (n: number): string => `The app is still working on ${n}`;

/** "2 more being checked": the quiet note beside a count that leaves out what the app is still working on. */
export const workingNote = (n: number): string => `${n} more being checked`;

/**
 * The choice a suggestion preselects: any suggestion that names one of the offered choices, verified or not, so one key
 * accepts it (HAX G7-G9). Whether it is verified is shown beside it; an answer that matches no choice preselects nothing.
 */
export function preselected(q: ReviewQuestion): string | null {
  const s = q.suggestion;
  if (!s || (s.status !== 'verified' && s.status !== 'unverified') || !s.choiceId) return null;
  return q.choices.some((c) => c.id === s.choiceId) ? s.choiceId : null;
}

/** What the chip beside a suggested choice says and how it looks; the why is the agent's own plain sentence when it sends one. */
export function suggestionChip(s: AiSuggestion): { label: string; tone: 'verified' | 'attention'; why: string } | null {
  if (s.status === 'verified') return { label: 'Verified', tone: 'verified', why: 'The page text quoted below says so.' };
  if (s.status === 'unverified' || s.status === 'unmatched') {
    return { label: 'Not verified', tone: 'attention', why: s.plain?.trim() || s.notVerified?.trim() || 'The code could not find these quotes on the page. Check the sources below.' };
  }
  return null;
}

/** What a list row shows of the AI: a chip when the code verified its answer, quiet words when it only suggested one, else nothing. */
export function rowChip(s: AiSuggestion | null): 'verified' | 'suggested' | null {
  if (!s) return null;
  if (s.status === 'verified') return 'verified';
  return s.status === 'unverified' || s.status === 'unmatched' ? 'suggested' : null;
}

/**
 * The footer's key hint: Enter saves the selected choice and moves to the next question. Without a choice it says what
 * is missing instead of a key that would do nothing.
 */
export function saveHint(o: { hasAnswer: boolean; hasNext: boolean }): string {
  if (!o.hasAnswer) return 'Choose an answer to save';
  return o.hasNext ? '↩ save and next' : '↩ save';
}

/**
 * Quotes grouped by the source they were found in (label and address), in the order each source first appears, each
 * line once. Details shows the source once as a link with its lines under it: no quote loses its source.
 */
export function groupBySource(quotes: Quote[]): { source: Source; texts: string[] }[] {
  const groups = new Map<string, { source: Source; texts: string[] }>();
  for (const q of quotes) {
    const key = `${q.source.label}|${q.source.url ?? ''}`;
    const g = groups.get(key) ?? { source: q.source, texts: [] };
    if (!g.texts.includes(q.text)) g.texts.push(q.text);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** The parts a verified research suggestion typed in, when it is not one of the choices. */
export function typedFromSuggestion(q: ReviewQuestion): string {
  const s = q.suggestion;
  if (!s || s.status !== 'verified' || s.choiceId) return '';
  return s.answer.split('+').map((p) => p.trim()).filter(Boolean).join(', ');
}

/** Models typed by hand: "DCF921B, dcd708b  DCB205" reads DCF921B, DCD708B, DCB205. */
export function parseTyped(text: string): string[] {
  return text
    .split(/[\s,;+]+/)
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
}
