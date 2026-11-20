// Real Review questions for the review assistant's tests: the validation replay (fixtures/validation/,
// no network) run once, its store and its questions. The replay answers every split question from the
// answer key (answers-2026-11-18.json); `asked` gives a question back as it was before that answer, and
// `keyOf` the answer key's parts.

import { CacheOnlyClient, loadInputs, ResponsesCache, runValidationPipeline, validationFiles } from '../../scripts/validate-cli';
import type { ReviewItem, ScanStore } from '../src/scan/types';

const DIR = 'fixtures/validation';

export interface AssistWorld {
  store: ScanStore;
  /** Every question the replay stored, by id. */
  questions: Map<string, ReviewItem>;
}

let world: Promise<AssistWorld> | null = null;

export function assistWorld(): Promise<AssistWorld> {
  world ??= (async () => {
    const files = validationFiles(DIR);
    const cache = new ResponsesCache(files.responses);
    const run = await runValidationPipeline({
      inputs: loadInputs(DIR), scanClient: new CacheOnlyClient(cache), lookupClient: new CacheOnlyClient(cache), continuePastMisses: true,
    });
    const questions = new Map((await run.store.listReview()).map((q) => [q.id, q] as const));
    return { store: run.store, questions };
  })();
  return world;
}

/** The question as the owner was asked it: open, no answer. Throws when the replay did not store it. */
export function asked(w: AssistWorld, id: string): ReviewItem {
  const q = w.questions.get(id);
  if (!q) throw new Error(`the replay stored no question ${id}`);
  return { ...q, answer: null, answerParts: null, answeredAt: null };
}

/** The parts the answer key gave a split question. */
export function keyOf(w: AssistWorld, id: string): string[] | null {
  return w.questions.get(id)?.answerParts ?? null;
}
