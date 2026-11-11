// The side panel's paid actions. Verify loads one Amazon listing's detail page (1 search) to
// upgrade a title match or send it to review. Look up runs the scan's own lookup step for parts
// left waiting: 1 search per part, nothing for a part a saved listing already answers. Both spend
// only through the client and budget they are given, check their whole cost against that budget
// before the first search, and never repeat a search that failed.

import { grade, pick } from '../match';
import type { SearchResult } from '../serpapi/client';
import { parseAmazonProduct } from '../serpapi/parsers';
import { wantedFor } from './classify';
import {
  applyLookup, bundleParts, type KnownModels, knownModels, type LookupStep, lookupWanted, markWaiting, matchFromListings, openMatchReview, type Part,
  type PartContext, pickFromListings, savePrice, sendLookup,
} from './runner';
import { DEFAULT_SCAN_SETTINGS, partKey } from './types';
import type { BudgetView, MatchRecord, PaidAction, Quote, ScanCounts, ScanSettings, ScanStore, SearchClient } from './types';

/** A paid action that was refused, or whose answer could not be used. The message is one plain sentence for the owner. */
export class PaidProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaidProblem';
  }
}

const UNREADABLE_REQUEST = 'That request could not be read.';
const CHOSEN_BY_YOU = 'You chose this listing yourself.';
const NOT_THE_MATCH = "This listing is no longer the part's match.";
const VERIFIED = 'This listing is already verified.';
const PAGE_UNREADABLE = "Amazon's page for this listing could not be read.";
const OTHER_LISTING = 'Amazon answered with a different listing.';
/** The reason of the match question a Verify opens; a lookup's reasons are written the same way. */
const NOT_CONFIRMED = "The listing's Amazon page does not confirm the part";
/** Added to the grading's reasons when the page's title says non-retail packaging, which pick() never uses. */
const BULK = 'the listing says non-retail packaging';

/** What the store already answers, read once by savedAnswers, for quotePaid. */
export interface SavedAnswers {
  /**
   * True when a Look up would not search for the part: it is in no resolved bundle, its match wants
   * no lookup (rule 5: matched, in review, none, or decided by the owner), or a saved listing
   * answers it, judged exactly as the scan's matchFromListings judges it (2c rule 5).
   */
  listingAnswers: (brand: string, model: string) => boolean;
}

// ---------------------------------------------------------------- the quote

/**
 * What the action would spend now, and the budget's own sentence when that does not fit. A
 * Verify is 1 search; a Look up is 1 per part asked for (each once) that `saved` does not answer.
 * Nothing to spend is never refused. The store's refusals are refusalFor's.
 */
export function quotePaid(action: PaidAction, saved: { listingAnswers: (brand: string, model: string) => boolean }, budget: BudgetView): Quote {
  const searches = action.kind === 'verify' ? 1 : partsOf(action.parts).filter((p) => !saved.listingAnswers(p.brand, p.model)).length;
  return { searches, refusal: overBudget(budget, searches) };
}

/** The SavedAnswers of the store as it is now. */
export async function savedAnswers(store: ScanStore): Promise<SavedAnswers> {
  const need = await judge(store, await knownModels(store));
  return { listingAnswers: (brand, model) => need(partsOf([{ brand, model }])[0]!) !== 'search' };
}

/**
 * Why `action` may not run against the store as it is now, in one sentence, or null. Reads the
 * store and spends nothing; the budget is quotePaid's. The request is untrusted: anything but a
 * paid action the panel offers is refused. A Verify needs the part's match to be this listing,
 * chosen automatically by its title (probable): never one the owner chose, nor one verified already.
 */
export async function refusalFor(store: ScanStore, action: PaidAction): Promise<string | null> {
  const problem = requestProblem(action);
  if (problem !== null) return problem;
  if (action.kind !== 'verify') return null;
  return verifyRefusal(await store.getMatch(partKey(action.brand, action.model)), action.asin.trim());
}

// ---------------------------------------------------------------- running it

/**
 * Runs one paid action. `settings` gives the Amazon domain and the brands whose listings are saved;
 * default DEFAULT_SCAN_SETTINGS. Ledger labels start with `panel:verify` and `panel:lookup`.
 * `shouldStop` is asked before every search, never during one, as a scan asks it: null goes on,
 * and a sentence, the caller's own, stops the action.
 *
 * Throws PaidProblem, having written and spent nothing, when refused: refusalFor's sentence, or the
 * budget's own when the whole cost does not fit. A failed search is thrown as the client threw it,
 * never retried. A Verify whose page cannot be used throws PaidProblem after its search. A stop
 * throws PaidProblem with shouldStop's sentence; the parts a Look up had not searched for yet wait.
 */
export async function runPaid(
  deps: {
    client: SearchClient; budget: BudgetView; store: ScanStore; now: () => number; settings?: ScanSettings; shouldStop?: () => string | null;
  },
  action: PaidAction,
): Promise<void> {
  const refusal = await refusalFor(deps.store, action);
  if (refusal !== null) throw new PaidProblem(refusal);
  const known = await knownModels(deps.store);
  const ctx: PartContext = {
    client: deps.client, store: deps.store, settings: deps.settings ?? DEFAULT_SCAN_SETTINGS, now: deps.now, prefix: 'panel', catalog: known.catalog,
    job: { counts: noCounts() },
  };
  const stop = deps.shouldStop ?? (() => null);
  if (action.kind === 'verify') await verify(ctx, deps.budget, action, stop);
  else await lookUp(ctx, deps.budget, known, action.parts, stop);
}

/**
 * Rule 5 and 2c rule 5 as a scan plans them, once: parts a saved listing answers are matched first,
 * for nothing; then one lookup per remaining part, in the order asked, through the scan's own step
 * (rule 6). A stop before a search, or a failed search, ends the action: that part and the ones
 * after it wait, as a scan leaves its queue when it halts.
 */
async function lookUp(
  ctx: PartContext, budget: BudgetView, known: KnownModels, asked: { brand: string; model: string }[], stop: () => string | null,
): Promise<void> {
  const need = await judge(ctx.store, known);
  const parts = partsOf(asked);
  const searches = parts.filter((p) => need(p) === 'search');
  const refusal = overBudget(budget, searches.length);
  if (refusal !== null) throw new PaidProblem(refusal);
  for (const part of parts) if (need(part) === 'listing') await matchFromListings(ctx, known.listings, part);
  const waitFrom = async (i: number) => {
    for (const p of searches.slice(i)) await markWaiting(ctx, { kind: 'lookup', brand: p.brand, model: p.model });
  };
  for (const [i, part] of searches.entries()) {
    const stopped = stop();
    if (stopped !== null) {
      await waitFrom(i);
      throw new PaidProblem(stopped);
    }
    const step: LookupStep = { kind: 'lookup', brand: part.brand, model: part.model };
    let result: SearchResult;
    try {
      result = await sendLookup(ctx, step);
    } catch (err) {
      await waitFrom(i);
      throw err;
    }
    await applyLookup(ctx, step, result.data, result.at);
  }
}

/**
 * One detail page (engine amazon_product), graded by the existing grading: pick() over that one
 * listing. Exact or strong: the match takes that grade. Probable: the page confirms no more than
 * the title did, and the match stays as it was. Anything else (review, reject, non-retail
 * packaging): the match goes to review, with a question offering this listing and the grading's
 * reasons. Either way the page's price is saved, at the time SerpApi answered. A page that cannot
 * be read, or that shows another listing, changes nothing.
 */
async function verify(
  ctx: PartContext, budget: BudgetView, action: Extract<PaidAction, { kind: 'verify' }>, stop: () => string | null,
): Promise<void> {
  const refusal = overBudget(budget, 1) ?? stop();
  if (refusal !== null) throw new PaidProblem(refusal);
  const part = partsOf([action])[0]!;
  const asin = action.asin.trim();
  const { data, at } = await ctx.client.search(
    { engine: 'amazon_product', asin, amazon_domain: ctx.settings.amazonDomain },
    // No maxAgeMs: a listing's brand, part number and barcode do not go stale; its price keeps its own time.
    { label: `${ctx.prefix}:verify:${part.model}` },
  );
  const page = parseAmazonProduct(data, asin);
  if (page === null) throw new PaidProblem(PAGE_UNREADABLE);
  if (page.asin !== asin) throw new PaidProblem(OTHER_LISTING);
  await savePrice(ctx, asin, page, at);
  // As after a lookup: the owner may have decided the part while the page loaded.
  const match = await ctx.store.getMatch(part.key);
  if (!match || verifyRefusal(match, asin) !== null) return;
  const want = wantedFor(part.brand, part.model, ctx.catalog);
  const now = ctx.now();
  const chosen = pick(want, [page]).chosen;
  if (chosen) {
    if (chosen.grade === 'exact' || chosen.grade === 'strong') {
      // The listings kept beside it were of its old grade: they are not its alternatives any more.
      await ctx.store.putMatch({ ...match, grade: chosen.grade, alternatives: [], updatedAt: now });
    }
    return;
  }
  const graded = grade(want, page);
  const reasons = graded.packaging === 'bulk' ? [...graded.reasons, BULK] : graded.reasons;
  // The question first, then the match, as a lookup writes them.
  await openMatchReview(ctx, part, NOT_CONFIRMED, [{ asin, title: page.title, price: page.price ?? null, reviews: page.reviews ?? null, reasons, seenAt: at }], now);
  await ctx.store.putMatch({ ...match, status: 'review', asin: null, grade: null, alternatives: [], updatedAt: now, waitingSince: null });
}

// ---------------------------------------------------------------- helpers

/** What a Look up does for a part: nothing, match it from a saved listing (free), or search. */
type Need = 'nothing' | 'listing' | 'search';

/** The store as it is now, read once: what a Look up would do for each part. */
async function judge(store: ScanStore, known: KnownModels): Promise<(part: Part) => Need> {
  const wanted = await bundleParts(store);
  const matches = new Map((await store.listMatches()).map((m) => [m.key, m]));
  return (part) => {
    // Rule 5: a part of a resolved bundle with no match or one left waiting, never one the owner decided.
    if (!wanted.has(part.key) || !lookupWanted(matches.get(part.key))) return 'nothing';
    return pickFromListings(part, known.catalog, known.listings).chosen ? 'listing' : 'search';
  };
}

function verifyRefusal(match: MatchRecord | undefined, asin: string): string | null {
  // An automatic step never changes what the owner decided.
  if (match?.decidedBy === 'user') return CHOSEN_BY_YOU;
  if (!match || match.status !== 'matched' || match.asin !== asin) return NOT_THE_MATCH;
  if (match.grade === 'exact' || match.grade === 'strong') return VERIFIED;
  return null;
}

/**
 * Why `searches` do not fit, or null when they do, and always for nothing. The sentence describes
 * the action, never a scan: nothing has stopped, so the scan's "Stopped: …" texts would be untrue.
 * More than the per-scan limit says what it needs and what to change (Ruling 53). A manual action
 * may use the reserve down to zero, so a reserve refusal means the month's searches are used up.
 * The hourly limit names the plan's number when the account gave one.
 */
function overBudget(budget: BudgetView, searches: number): string | null {
  if (searches === 0) return null;
  const reason = budget.blockReason(searches);
  const needs = `This needs ${searches} ${searches === 1 ? 'search' : 'searches'}`;
  switch (reason) {
    case null:
      return null;
    case 'run_cap':
      return `${needs}, and a scan may use ${budget.leftThisRun}. Raise the searches per scan in settings to do it here.`;
    case 'reserve': {
      const left = budget.leftAboveReserve;
      return left <= 0 ? 'No searches are left this month.' : `${needs}, and ${left} ${left === 1 ? 'is' : 'are'} left this month.`;
    }
    case 'hourly_limit':
      return budget.hourlyLimit === null
        ? "SerpApi's hourly limit is reached. Try again later."
        : `SerpApi allows ${budget.hourlyLimit} searches an hour, and they are used. Try again later.`;
  }
}

/** The parts asked for, each once, in the order asked, brand and model upper case. */
function partsOf(asked: { brand: string; model: string }[]): Part[] {
  const parts = new Map<string, Part>();
  for (const p of asked) {
    const key = partKey(p.brand, p.model);
    if (!parts.has(key)) parts.set(key, { key, brand: p.brand.trim().toUpperCase(), model: p.model.trim().toUpperCase() });
  }
  return [...parts.values()];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Null for a well-formed paid action the panel offers; otherwise the sentence that refuses it. The request is untrusted. */
export function requestProblem(action: unknown): string | null {
  if (!isRecord(action)) return UNREADABLE_REQUEST;
  if (action.kind === 'verify') return isText(action.brand) && isText(action.model) && isText(action.asin) ? null : UNREADABLE_REQUEST;
  if (action.kind !== 'lookUp') return UNREADABLE_REQUEST;
  const { parts } = action;
  return Array.isArray(parts) && parts.length > 0 && parts.every((p) => isRecord(p) && isText(p.brand) && isText(p.model)) ? null : UNREADABLE_REQUEST;
}

/** A scan's counts at zero: the panel's steps count into them, and they are not kept. */
const noCounts = (): ScanCounts => ({
  pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0,
  catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0,
});
