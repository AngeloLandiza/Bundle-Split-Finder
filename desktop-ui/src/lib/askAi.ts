// What Review says after he presses Ask AI. A press is never silent (docs/ux-checklist.md, "A press is acknowledged at
// once"): the answer is shown at once, either that the app took it ("Checking again…", the spinner on the row) or why it
// did not, with the one action that reason implies. Pure; Review draws it.

import { isWorking, type AskAiResult, type ReviewQuestion } from '../api/types';
import { money } from './format';

export type AskNote =
  /** The press was sent; the agent has not answered. */
  | { phase: 'sending' }
  /** The agent took it. `sig` is the question as it was: the row stops saying "Checking again…" when the question changes. */
  | { phase: 'queued'; sig: string; at: number }
  /** Nothing was started, and why; `force` when asking anyway is what the reason implies. */
  | { phase: 'declined'; reason: string; force: boolean; sig: string; costUsd?: number }
  /** The call itself failed. */
  | { phase: 'failed'; text: string };

/** What the row says while the app is on it. */
export const CHECKING_AGAIN = 'Checking again…';

/** A queued note that the agent never followed with a change is dropped after this long. */
export const QUEUED_MS = 120_000;

/** The question's state that Ask AI changes: a different value means the agent has done something with the press. */
export function askSig(q: ReviewQuestion): string {
  return [q.followUp?.state ?? '-', q.followUp?.tried.length ?? 0, q.suggestion?.status ?? '-', q.suggestion?.answer ?? '', q.suggestion?.reason?.length ?? 0].join('|');
}

/**
 * A reason that is the "nothing new" kind: asking again is exactly what he may want, at the price shown. Any other reason
 * (already working, no key, nothing to read) is said as it is, with no action: asking anyway would not change it.
 */
const NOTHING_NEW = /nothing new|no new|unchanged|nothing (?:has )?changed|since the last/i;

/** The note for the agent's answer to a press. */
export function noteOf(r: AskAiResult, q: ReviewQuestion, now: number): AskNote {
  if (r.queued) return { phase: 'queued', sig: askSig(q), at: now };
  const reason = r.reason?.trim() || 'The AI did not start.';
  // The agent says whether asking anyway would start (`canForce`); an older agent says nothing, and then the words decide.
  const force = r.canForce ?? (q.askCostUsd !== null && NOTHING_NEW.test(reason));
  return { phase: 'declined', reason, force, sig: askSig(q), ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) };
}

/** The action beside a declined press: "Ask anyway · about $0.07". Null when the reason implies none. */
export function forceLabel(note: AskNote, q: ReviewQuestion): string | null {
  if (note.phase !== 'declined' || !note.force) return null;
  const cost = note.costUsd ?? q.askCostUsd;
  return `Ask anyway${cost !== null ? ` · about ${money(cost)}` : ''}`;
}

/**
 * A press that can be answered without asking the agent: no key, nothing the AI could read, or the app already on it.
 * Null when the agent should be asked.
 */
export function refusedHere(q: ReviewQuestion, o: { hasAi: boolean }): string | null {
  if (isWorking(q.followUp)) return 'The app is already working on this one.';
  if (!o.hasAi) return 'Ask AI needs an Anthropic or OpenAI key. Add one in Settings, under AI.';
  if (q.askCostUsd === null) return 'There is nothing more the AI could read for this question, so nothing was started.';
  return null;
}

/** The notes still true: a queued one ends when its question changed, is gone, or the agent never followed it up. */
export function settled(notes: Record<string, AskNote>, questions: readonly ReviewQuestion[], now: number): Record<string, AskNote> {
  const out: Record<string, AskNote> = {};
  for (const [id, n] of Object.entries(notes)) {
    if (n.phase === 'declined' && (!questions.some((x) => x.id === id) || askSig(questions.find((x) => x.id === id)!) !== n.sig)) continue;
    if (n.phase === 'queued') {
      const q = questions.find((x) => x.id === id);
      if (!q || askSig(q) !== n.sig || now - n.at > QUEUED_MS) continue;
    }
    out[id] = n;
  }
  return out;
}
