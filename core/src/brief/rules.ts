// The rules brief: always available, no model, no cost. It is built from the question's kind and its own note, the
// suggestion's status and chosen reading, and the verifier's plain sentences (assist/plain.ts), with the quotes the code
// found. It says less than a model's brief, and nothing it says is a guess: every line is a template filled from
// records the app holds. It is what the owner sees until (or unless) a model brief passes the checks in ground.ts.

import { plainNote } from '../review/words';
import type { BriefCheck, BriefInput, BriefReason, ReviewBrief } from './types';

/** A sentence of a brief is at most this long. */
export const MAX_REASON_CHARS = 110;
export const MAX_REASONS = 3;
/** What check text is cut to. */
export const MAX_CHECK_CHARS = 140;

export const cutText = (text: string, max: number): string => {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

const STATE_SENTENCE = {
  cannot_tell: 'The AI could not tell from the pages the app has.',
} as const;

/** The rules check: where to look, by the question's kind and what is known. */
export function rulesCheck(input: BriefInput): BriefCheck | null {
  const link = input.checkLink;
  let text: string;
  if (input.kind === 'split') {
    text = input.state === 'verified'
      ? 'Read the Includes list on the Home Depot page and see that it holds these parts.'
      : 'Read the Includes list on the Home Depot page and see what the bundle holds.';
  } else {
    text = input.state === 'verified'
      ? 'Open the Amazon listing and see that it is this exact part, new.'
      : 'Open the Amazon listings and see which one is this exact part, new.';
  }
  return { text: cutText(text, MAX_CHECK_CHARS), ...(link ? { url: link.url, linkLabel: link.label } : {}) };
}

/** A rules sentence is plain words filled from a template: up to this long (a model's reasons are held to MAX_REASON_CHARS). */
export const MAX_RULES_REASON_CHARS = 140;

/** The question's own note in plain words (review/words.ts, the app's own wording), the notes it knows only; null when it knows none. */
function whyAsked(input: BriefInput): BriefReason | null {
  let text = '';
  for (const note of input.note.split(';').map((n) => n.trim()).filter(Boolean)) {
    const plain = plainNote(note, { brand: input.brand, model: input.model });
    if (plain === null) continue;
    const next = text === '' ? plain : `${text} ${plain}`;
    if (next.length > MAX_RULES_REASON_CHARS) {
      if (text === '') text = cutText(plain, MAX_RULES_REASON_CHARS);
      break;
    }
    text = next;
  }
  return text === '' ? null : { text };
}

/** The sentences of a rules brief, most useful first, at most three. */
function rulesReasons(input: BriefInput): BriefReason[] {
  const out: BriefReason[] = [];
  const first = input.quotes[0];
  if (input.state === 'verified') {
    const where = input.kind === 'split' ? 'The Home Depot page names each part.' : 'The Amazon listing title names the part.';
    out.push({ text: where, ...(first ? { quote: first.text, sourceLabel: first.label, ...(first.url ? { url: first.url } : {}) } : {}) });
    const second = input.quotes[1];
    if (second) out.push({ text: `More from the ${second.label}.`, quote: second.text, sourceLabel: second.label, ...(second.url ? { url: second.url } : {}) });
  } else if (input.state === 'not_verified') {
    // The verifier's own sentences, no quote beside them: the quotes the AI gave are not what these sentences are about.
    for (const p of input.plainReasons.slice(0, 2)) out.push({ text: cutText(p, MAX_RULES_REASON_CHARS) });
    if (out.length === 0) out.push({ text: cutText(input.verdict[0] ?? 'The app could not confirm the AI’s answer.', MAX_RULES_REASON_CHARS) });
  } else if (input.state === 'cannot_tell') {
    out.push({ text: STATE_SENTENCE.cannot_tell });
  }
  const why = out.length < MAX_REASONS ? whyAsked(input) : null;
  if (why) out.push(why);
  return out.slice(0, MAX_REASONS);
}

/** The brief the rules write for one question. Pure; never fails. */
export function rulesBrief(input: BriefInput): ReviewBrief {
  return {
    ask: input.ask,
    suggestion: input.proposed,
    state: input.state,
    reasons: rulesReasons(input),
    check: rulesCheck(input),
    writtenBy: 'rules',
  };
}
