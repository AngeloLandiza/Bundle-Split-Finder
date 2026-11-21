// Ask AI for one Review question: the evidence the scan stored, one model call, the code's check. The
// result is a Suggestion to show the owner, never an answer: nothing here writes to the store, and
// only the owner's Approve saves an answer, through the existing path (applyReviewAnswer).

import { choicesOf, reviewSignature } from '../scan/answers';
import type { ReviewItem } from '../scan/types';
import { ASSIST_PROMPT_VERSION, assistRequest } from './prompt';
import type { AssistEvidence, AssistModel, Suggestion } from './types';
import { verifySuggestion } from './verify';

/**
 * Asks `model` for a suggested answer to `question` and checks it. Makes no call for a question the
 * owner has answered, or one that offers nothing to choose. One call, no retries; never throws: a
 * failed call is `not_suggested`.
 */
export async function suggestAnswer(question: ReviewItem, evidence: AssistEvidence, model: AssistModel, signal?: AbortSignal): Promise<Suggestion> {
  const meta = { questionId: question.id, seen: reviewSignature(question), provider: model.provider, model: model.model, promptVersion: ASSIST_PROMPT_VERSION };
  const notSuggested = (reason: string): Suggestion => ({ ...meta, status: 'not_suggested', reason });

  if (question.answer !== null) return notSuggested('That question was already answered.');
  if (evidence.questionId !== question.id || evidence.kind !== question.kind) return notSuggested('The evidence is for another question.');
  if (question.kind === 'split' && choicesOf(question).length === 0) {
    return notSuggested('This question offers no readings to choose from. Enter the parts yourself.');
  }
  if (question.kind === 'match' && question.candidates.length === 0) {
    return notSuggested('This question offers no listings to choose from. Confirm a sell price on the part if you have seen one.');
  }

  let call;
  try {
    call = await model.ask(assistRequest(question, evidence), signal);
  } catch {
    return notSuggested('The model failed without an answer.');
  }
  if (!call.ok) {
    return { ...meta, status: 'not_suggested', reason: call.notJudged.message, notSuggested: call.notJudged, ...(call.usage ? { usage: call.usage } : {}) };
  }
  return { ...meta, ...verifySuggestion(call.answer, question, evidence), usage: call.usage };
}
