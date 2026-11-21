// The side panel's paid actions. Verify loads one Amazon listing's detail page (1 search) to
// upgrade a title match or send it to review. Look up runs the scan's own lookup step for parts
// left waiting: 1 search per part, nothing for a part a saved listing already answers. Both spend
// only through the client and budget they are given, check their whole cost against that budget
// before the first search, and never repeat a search that failed.

import { type Candidate, grade, kitKey, pick } from '../match';
import { BudgetExceededError, RateLimitedError, type SearchResult } from '../serpapi/client';
import { parseAmazonProduct, parseBuyBox } from '../serpapi/parsers';
import { wantedFor } from './classify';
import { listingFrom } from './listings';
import {
  applyIdentify, applyLookup, bundleParts, failingBefore, type KnownModels, knownModels, lookupOrder, type LookupStep, lookupWanted, markWaiting, matchFromListings, notePageDue,
  NOT_CONFIRMED, openMatchReview, pageEvidence, type Part, type PartContext, pickFromListings, savePrice, sendLookup, sharedMatch,
} from './runner';
import { writeTwins } from './twins';
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

/** What the store already answers, read once by savedAnswers, for quotePaid. */
export interface SavedAnswers {
  /**
   * True when a Look up would not search for the part: it is in no resolved bundle nor among the
   * items of a kit one splits (bundleParts; whatever that kit's own listing), its match wants
   * no lookup (rule 5: matched, in review, none, or decided by the owner), or a saved listing
   * answers it, judged exactly as the scan's matchFromListings judges it (2c rule 5).
   */
  listingAnswers: (brand: string, model: string) => boolean;
}

// ---------------------------------------------------------------- the quote

/**
 * What the action would spend now, and the budget's own sentence when that does not fit. A
 * Verify is 1 search; a Look up is 1 per part asked for (each once) that `saved` does not answer,
 * at most the per-scan limit when that is at least 1 (Ruling 72): the parts past it are counted in
 * `leftWaiting`. Nothing to spend is never refused. The store's refusals are refusalFor's.
 */
export function quotePaid(action: PaidAction, saved: { listingAnswers: (brand: string, model: string) => boolean }, budget: BudgetView): Quote {
  if (action.kind === 'verify') return { searches: 1, refusal: overBudget(budget, 1) };
  // Ruling 70: a RYOBI part asked for in both its written forms is one search (onePerProduct); then
  // Ruling 72's cap, exactly as lookUp counts them, so the quote is what a press spends.
  const needed = lookupsNeeded(action.parts, saved);
  const searches = fitting(budget, needed);
  const quote: Quote = { searches, refusal: overBudget(budget, searches) };
  if (searches < needed) quote.leftWaiting = needed - searches;
  return quote;
}

/**
 * The searches a Look up of `parts` needs, before any limit or budget: one per part asked for that
 * `saved` does not answer, a RYOBI part written two ways once (Ruling 70). quotePaid caps it by the
 * per-scan limit (Ruling 72); a product page the owner has open shows it uncapped (pageView.ts),
 * since the cap and the budget need the account, and reading a page never checks it.
 */
export function lookupsNeeded(parts: { brand: string; model: string }[], saved: Pick<SavedAnswers, 'listingAnswers'>): number {
  return onePerProduct(partsOf(parts).filter((p) => !saved.listingAnswers(p.brand, p.model))).length;
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
 * budget's own when the cost does not fit. A Look up's cost is what fits the per-scan limit (Ruling
 * 72; quotePaid): the parts past it wait for the next press or scan. A failed search is thrown as the client threw it,
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
 * for nothing; then one lookup per remaining part, best first in the scan's own order (Ruling 72),
 * through the scan's own step (rule 6). Only what fits the per-scan limit is searched for; the rest
 * wait, as a scan leaves the lookups it defers. When that search's titled rows are all accessories,
 * one product page is read too, only if the limit still allows it beside the lookups left; otherwise
 * the page is owed to the next scan. The quote stays the lookups it could count before the search
 * returned. A stop before a search, or a failed search, ends
 * the action: that part and the ones after it wait, as a scan leaves its queue when it halts, and a
 * part whose search failed waits from the failure on (waitsFromNow).
 */
async function lookUp(
  ctx: PartContext, budget: BudgetView, known: KnownModels, asked: { brand: string; model: string }[], stop: () => string | null,
): Promise<void> {
  const need = await judge(ctx.store, known);
  const parts = partsOf(asked);
  // Ruling 70: one search per product, the form asked first; the other written form takes its match
  // after the searches. Then Ruling 72: best first in the scan's order, as many as fit. As quotePaid counts.
  const wanted = await scanOrder(ctx.store, onePerProduct(parts.filter((p) => need(p) === 'search')));
  const searches = wanted.slice(0, fitting(budget, wanted.length));
  const refusal = overBudget(budget, searches.length);
  if (refusal !== null) throw new PaidProblem(refusal);
  for (const part of parts) if (need(part) === 'listing') await matchFromListings(ctx, known.listings, part);
  // Every part to search for waits from the press on, keeping when it began to wait, as a scan marks
  // the lookups it defers: the ones past the limit, and any a stop or a failure leaves.
  for (const p of wanted) await markWaiting(ctx, { kind: 'lookup', brand: p.brand, model: p.model });
  for (let i = 0; i < searches.length; i++) {
    const part = searches[i]!;
    const stopped = stop();
    if (stopped !== null) throw new PaidProblem(stopped);
    const step: LookupStep = { kind: 'lookup', brand: part.brand, model: part.model };
    let result: SearchResult;
    try {
      result = await sendLookup(ctx, step);
    } catch (err) {
      await waitsFromNow(ctx, part);
      throw err;
    }
    const asin = await applyLookup(ctx, step, result.data, result.at);
    if (!asin) continue;
    // One more search, only beside the lookups this press still has to run. Otherwise the page is owed.
    const rest = searches.length - i - 1;
    if (stop() === null && budget.blockReason(rest + 1) === null) {
      try {
        const page = await ctx.client.search(
          { engine: 'amazon_product', asin, amazon_domain: ctx.settings.amazonDomain },
          { label: `${ctx.prefix}:identify:${part.model}` },
        );
        await applyIdentify(ctx, { kind: 'identify', brand: part.brand, model: part.model, asin }, page.data, page.at);
      } catch (err) {
        if (err instanceof BudgetExceededError || err instanceof RateLimitedError) {
          await notePageDue(ctx, step, asin);
          throw err;
        }
      }
    } else {
      await notePageDue(ctx, step, asin);
    }
  }
  // Ruling 70: the forms onePerProduct skipped, never those past the limit, take their twin's result.
  for (const part of parts) if (need(part) === 'search' && !wanted.includes(part)) await matchFromListings(ctx, known.listings, part);
}

/**
 * A part whose lookup failed in a press waits from now, so it ranks after the parts that waited
 * before it, in the next press and the next scan (lookupOrder; the scan sets aside its own failures
 * in `failingParts`, Rulings 50 and 57). Without this a lookup that keeps failing would come first on
 * every press and end it each time. Never a part the owner decided, nor one whose result came from a
 * listing's page (pageEvidence).
 */
async function waitsFromNow(ctx: PartContext, part: Part): Promise<void> {
  const match = await ctx.store.getMatch(part.key);
  if (!match || match.status !== 'waiting' || match.decidedBy === 'user') return;
  // Q1a fix round 3: nor a result a Verify wrote from the listing's page, as markWaiting and applyLookup skip it.
  if ((await pageEvidence(ctx.store, match)).page) return;
  const now = ctx.now();
  await ctx.store.putMatch({ ...match, waitingSince: now, updatedAt: now });
}

/**
 * One detail page (engine amazon_product), graded by the existing grading: pick() over that one
 * listing. Exact or strong: the match takes that grade. Probable: the page confirms no more than
 * the title did, and the match stays as it was. Review or reject: the match goes to review, with a
 * question offering this listing and the grading's reasons. Bulk or non-retail packaging alone sends
 * nothing to review (PO, Nov 18): pick() may choose a New bulk listing, and packaging is not a grade.
 * Either way the page's price is saved, at the time SerpApi answered. A page that cannot be read, or
 * that shows another listing, changes nothing.
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
  await saveBuyBox(ctx, page, parseBuyBox(data), at);
  // As after a lookup: the owner may have decided the part while the page loaded.
  const match = await ctx.store.getMatch(part.key);
  if (!match || verifyRefusal(match, asin) !== null) return;
  const want = wantedFor(part.brand, part.model, ctx.catalog);
  const now = ctx.now();
  const chosen = pick(want, [page]).chosen;
  // Fix round 1, Important 1: the outcome is also the twin's, when the twin holds this listing automatically.
  const sameListing = (twin: MatchRecord) => twin.decidedBy === 'auto' && twin.status === 'matched' && twin.asin === asin;
  if (chosen) {
    if (chosen.grade === 'exact' || chosen.grade === 'strong') {
      // The listings kept beside it were of its old grade: they are not its alternatives any more.
      const upgraded: MatchRecord = { ...match, grade: chosen.grade, alternatives: [], updatedAt: now };
      await ctx.store.putMatch(upgraded);
      await writeTwins(ctx.store, upgraded, sameListing);
    }
    return;
  }
  const { reasons } = grade(want, page);
  // The question first, then the match, as a lookup writes them.
  await openMatchReview(ctx, part, NOT_CONFIRMED, [{ asin, title: page.title, price: page.price ?? null, reviews: page.reviews ?? null, reasons, seenAt: at }], now);
  // Fix round 2: the page's evidence stands; no scan matches the part to this listing again from a search row.
  const inReview: MatchRecord = {
    ...match, status: 'review', asin: null, grade: null, alternatives: [], updatedAt: now, waitingSince: null,
    source: 'page', rejectedAsins: [...new Set([...(match.rejectedAsins ?? []), asin])],
  };
  await ctx.store.putMatch(inReview);
  await writeTwins(ctx.store, inReview, sameListing);
}

/**
 * Step 9: the page's "Buy New" box, on the listing, as seen at `at`; null when the page shows none. A
 * listing not saved yet is saved from the page as a search row would be (listingFrom: only a scanned
 * brand). A box seen later than `at` is kept.
 */
async function saveBuyBox(ctx: PartContext, page: Candidate, box: ReturnType<typeof parseBuyBox>, at: number): Promise<void> {
  const old = await ctx.store.getListing(page.asin);
  if (old?.buyBox && old.buyBox.seenAt > at) return;
  const listing = old ?? listingFrom(page, ctx.settings.brands, at);
  if (listing === null) return;
  await ctx.store.putListing({ ...listing, buyBox: box === null ? null : { ...box, seenAt: at } });
}

// ---------------------------------------------------------------- helpers

/** What a Look up does for a part: nothing, match it from a saved listing (free), or search. */
type Need = 'nothing' | 'listing' | 'search';

/** The store as it is now, read once: what a Look up would do for each part. */
async function judge(store: ScanStore, known: KnownModels): Promise<(part: Part) => Need> {
  const wanted = await bundleParts(store);
  const matches = new Map((await store.listMatches()).map((m) => [m.key, m]));
  return (part) => {
    // Rule 5: a part of a resolved bundle, or (step 6) an item of a kit one splits, with no match or one
    // left waiting, never one the owner decided. The owner asks for a kit's items: not the scan's kit rule.
    if (!wanted.has(part.key) || !lookupWanted(matches.get(part.key))) return 'nothing';
    // Ruling 70: the match of the part's other written form stands for it, free (matchFromListings).
    if (sharedMatch(part, (key) => matches.get(key), matches.get(part.key))) return 'listing';
    return pickFromListings(part, known.catalog, known.listings).chosen ? 'listing' : 'search';
  };
}

/**
 * Ruling 72: how many of a Look up's `searches` one press spends. All of them, or as many as the
 * per-scan limit allows when it allows at least one. Under a limit of 0 nothing fits, and the
 * whole cost is refused with Ruling 53's sentence. The reserve and the hourly limit are not
 * counted here: overBudget refuses on them, with their own sentences.
 */
function fitting(budget: BudgetView, searches: number): number {
  const cap = Math.floor(budget.leftThisRun);
  return cap >= 1 ? Math.min(searches, cap) : searches;
}

/**
 * Ruling 72: `parts` (each a part some bundle wants) best first, in the order a scan would look
 * them up: lookupOrder over the store as it is now, with kit items after every other part.
 */
async function scanOrder(store: ScanStore, parts: Part[]): Promise<Part[]> {
  if (parts.length < 2) return parts;
  const wanted = await bundleParts(store);
  const matches = new Map((await store.listMatches()).map((m) => [m.key, m]));
  // As wantedParts sets it: a part to look up with a match record ranks by when it began to wait.
  const waitingSince = new Map<string, number>();
  for (const p of parts) {
    const match = matches.get(p.key);
    if (match) waitingSince.set(p.key, match.waitingSince ?? 0);
  }
  const { byLookup } = lookupOrder(wanted, waitingSince, failingBefore(await store.listScans()));
  const item = (p: Part) => ((wanted.get(p.key)?.kits.length ?? 0) > 0 ? 1 : 0);
  return [...parts].sort((a, b) => item(a) - item(b) || byLookup(a.key, b.key));
}

/** Ruling 70: the parts with only the first of a RYOBI part's two written forms (kitKey), in order. */
function onePerProduct(parts: Part[]): Part[] {
  const seen = new Set<string>();
  return parts.filter((p) => !seen.has(kitKey(p.brand, p.model)) && !!seen.add(kitKey(p.brand, p.model)));
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

/** A scan's counts at zero: the panel's steps (and a product page's, pageView.ts) count into them, and they are not kept. */
export const noCounts = (): ScanCounts => ({
  pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0,
  catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0,
});
