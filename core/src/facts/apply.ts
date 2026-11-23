// Answer once (Nov 23): writing what the owner settled about a model, and applying it at once to every bundle that holds it.
// A fact settles an open "What is A986501 in this bundle?" question the way a scan would (runner.ts
// withdrawUnreadSplitQuestions: the question read again under the settle rules, which read the facts). Forgetting a fact
// reads again the splits it settled, so their questions come back. Never a search; never touches an answer he gave himself.

import { splitOne, withdrawUnreadSplitQuestions } from '../scan/runner';
import { knownModels } from '../scan/split';
import { partKey, type ReviewItem, type ScanStore } from '../scan/types';
import { factsFromAnswer, type FactField, type FactMark, type PartFact, type RememberOutcome, withFact, withoutFact } from './fact';

type FactStore = Required<Pick<ScanStore, 'getPartFact' | 'putPartFact' | 'deletePartFact' | 'listPartFacts'>>;

/** Facts need a store that keeps them (the agent's, the memory store); the extension's does not. */
function factsOf(store: ScanStore): FactStore {
  if (!store.getPartFact || !store.putPartFact || !store.deletePartFact || !store.listPartFacts) throw new Error('This store keeps no part facts.');
  return store as FactStore;
}

/** Sets one field of a model's fact. */
export async function putFact(store: ScanStore, brand: string, model: string, field: FactField, mark: FactMark, parts?: string[] | null): Promise<PartFact> {
  const s = factsOf(store);
  const next = withFact(await s.getPartFact(partKey(brand, model)), brand, model, field, mark, parts);
  await s.putPartFact(next);
  return next;
}

export interface Remembered extends RememberOutcome {
  /** Open questions the facts settled (closed as a scan closes one), by id. */
  settled: string[];
}

/**
 * After the owner answered split question `item` (already applied, answers.ts): the facts he asked to remember, written,
 * then every open split question read again with them. Nothing to remember: nothing is written and nothing is read again.
 */
export async function rememberAnswer(store: ScanStore, item: ReviewItem, remember: readonly string[], now: number): Promise<Remembered> {
  const out = factsFromAnswer(item, remember, now);
  if (out.facts.length === 0) return { ...out, settled: [] };
  for (const f of out.facts) await putFact(store, f.brand, f.model, f.field, f.mark, f.parts);
  return { ...out, settled: await withdrawUnreadSplitQuestions(store, now) };
}

/** "In the box, not sold separately" for a model, from a part row; or kept again (a new date) after newer evidence. */
export async function markNotSold(store: ScanStore, brand: string, model: string, now: number): Promise<PartFact> {
  return putFact(store, brand, model, 'notSoldSeparately', { at: now });
}

/**
 * Forgets a model's fact (one field, or all of it with null), then reads again every resolved split an owner fact about that
 * model settled, as a scan splits it: those bundles are asked about again. Returns the bundles read again.
 */
export async function forgetFact(store: ScanStore, key: string, field: FactField | null, now: number): Promise<string[]> {
  const s = factsOf(store);
  const prev = await s.getPartFact(key);
  if (!prev) return [];
  const next = field === null ? null : withoutFact(prev, field, now);
  if (next) await s.putPartFact(next);
  else await s.deletePartFact(key);
  const settledBy = (await store.listBundles()).filter((b) =>
    b.brand.trim().toUpperCase() === prev.brand && b.split?.status === 'resolved' &&
    (b.split.evidence ?? []).some((e) => e.kind === 'owner_fact' && e.model === prev.model));
  if (settledBy.length === 0) return [];
  const known = await knownModels(store);
  for (const b of settledBy) await splitOne(store, b, known, now, true);
  return settledBy.map((b) => b.key);
}
