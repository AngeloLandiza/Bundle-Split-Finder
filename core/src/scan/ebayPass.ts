// Step 10: the scan's eBay step. For each part model, in order: one eBay search (New, fixed price, Power Tools),
// the deterministic pre-filter, one item read for each listing it keeps, and one judgement for each of those
// (a saved answer first). What comes out is a reference value per part (EbayValueRecord): never counted in an
// estimate, and absent, never $0, when no verified match has sold.
//
// Everything outside is passed in: an eBay port (EbayClient satisfies it), a ListingJudge, the store and the
// clock. Core stays pure; the extension builds the client and the judge from the owner's own keys.
//
// The step is optional and never stops a scan. A refused key, a limit, a failed call: one plain sentence in
// the job's `ebayNotice`, and the scan goes on to its Amazon lookups.

import {
  EbayAuthError, EbayCapError, EbayForbiddenError, EbayRateLimitedError, type EbaySearchOptions, type EbaySearchResult,
} from '../ebay/client';
import { POWER_TOOLS_CATEGORY, preFilter } from '../ebay/filter';
import type { EbayListing } from '../ebay/types';
import { ebayValue } from '../ebay/value';
import { judgeListingFromEbay } from '../judge/fromEbay';
import { PROMPT_VERSION } from '../judge/prompt';
import type { JudgeCall, JudgeInput, JudgeOutcome, ListingJudge } from '../judge/types';
import { judgeListing } from '../judge/verify';
import { modelForms } from '../match';
import { twinKeys } from './twins';
import {
  type EbayJudgedListing, type EbayOwnerAnswer, type EbayValueRecord, ebayAnswerKey, effectiveVerdict, judgementKey, type ScanJob, type ScanStore,
} from './types';

/** The most eBay searches and item reads one scan makes (free, but eBay's calls are the owner's own quota). */
export const EBAY_SEARCHES_MAX = 40;
export const EBAY_ITEM_READS_MAX = 300;
/** Longest one model call may take before it is given up as not judged. */
export const JUDGE_CALL_TIMEOUT_MS = 30_000;
/** Settings' starting number of listings the model is asked about in one scan. */
export const DEFAULT_LISTINGS_JUDGED_PER_SCAN = 60;
/** The most Settings may ask for. */
export const MAX_LISTINGS_JUDGED_PER_SCAN = 500;

/** What the step needs of eBay. EbayClient satisfies it. */
export interface EbayPort {
  search(query: string, opts?: EbaySearchOptions): Promise<EbaySearchResult>;
  getItem(itemId: string): Promise<EbayListing>;
}

/** The step, or why it is skipped. The extension builds `run` only when it holds all three keys. */
export type EbayStep =
  | {
      kind: 'run';
      ebay: EbayPort;
      judge: ListingJudge;
      listingsJudgedPerScan: number;
      /** True once the step must go no further, apart from a stop of the scan: the owner removed or changed a key it holds. */
      halted?: () => boolean;
      /** Aborted when the scan is stopped: a model call in flight ends at once. The step's own eBay calls are bound to it by the caller's fetch. */
      signal?: AbortSignal;
      /** Longest a model call may take; default JUDGE_CALL_TIMEOUT_MS. A call that runs out is not judged, never a verdict. */
      callTimeoutMs?: number;
    }
  | { kind: 'skip'; notice: string };

/** A part to check: partKey and its brand and model, upper case. */
export interface EbayPart {
  key: string;
  brand: string;
  model: string;
}

export interface EbayPassArgs {
  store: ScanStore;
  /** Its counts and ebayNotice are updated; `save` is called to keep them. */
  job: ScanJob;
  save: () => Promise<void>;
  parts: EbayPart[];
  ebay: EbayPort;
  judge: ListingJudge;
  listingsJudgedPerScan: number;
  now: () => number;
  shouldStop: () => boolean;
  signal?: AbortSignal;
  callTimeoutMs?: number;
}

const NOTICE = {
  ebayKeys: 'eBay did not accept the App ID and Cert ID, so eBay reference values were not checked. Check them in Settings.',
  ebayForbidden: 'eBay says these keys may not make this call, so eBay reference values were not checked.',
  ebayLimited: 'eBay is limiting calls, so the rest of the eBay reference values wait for the next scan.',
  claudeKey: 'Claude did not accept the Anthropic key, so eBay listings were not judged. Check the key in Settings.',
  claudeRequest: 'Claude refused the request (an unknown model, no credit or a bad request), so eBay listings were not judged. Check the model and your Anthropic account.',
  claudeLimited: "Claude's rate limit was reached, so the rest of the eBay listings wait for the next scan.",
  searches: `The limit of ${EBAY_SEARCHES_MAX} eBay searches a scan was reached. The rest wait for the next scan.`,
  reads: `The limit of ${EBAY_ITEM_READS_MAX} eBay listing reads a scan was reached. The rest wait for the next scan.`,
  judged: (n: number) => `The limit of ${n} listings judged a scan was reached. The rest wait for the next scan.`,
} as const;

/** Adds one sentence to the job's eBay notice, once. */
export function noteEbay(job: ScanJob, sentence: string): void {
  if (!job.ebayNotice) job.ebayNotice = sentence;
  else if (!job.ebayNotice.includes(sentence)) job.ebayNotice = `${job.ebayNotice} ${sentence}`;
}

/** The part's other written form, for the judge: PCL206 for PCL206B and the reverse. RYOBI only. */
function twinOf(brand: string, model: string): string | undefined {
  return modelForms(brand, model).find((f) => f !== model.trim().toUpperCase());
}

/** The part's name: Home Depot's title from the stored catalog, under the part's key or a twin's. */
async function nameOf(store: ScanStore, part: EbayPart): Promise<string | undefined> {
  for (const key of [part.key, ...twinKeys(part.brand, part.model)]) {
    const entry = await store.getCatalogEntry(key);
    if (entry?.title) return entry.title;
  }
  return undefined;
}

/** A stored judged listing as ebayValue reads it: the fields it uses, nothing else. */
function listingForValue(l: EbayJudgedListing): EbayListing {
  return {
    itemId: l.itemId, title: l.title, price: l.price, currency: l.currency, conditionId: '1000', categoryIds: [], aspects: [],
    descriptionText: '', soldQuantity: l.soldQuantity, url: l.url,
  };
}

/** The value of a part's judged listings, each counted at its effective verdict (the owner's answer, else the judge's). */
export const valueOf = (listings: EbayJudgedListing[]) =>
  ebayValue(listings.map((l) => ({ listing: listingForValue(l), verdict: effectiveVerdict(l) })));

/** The listing with the owner's answer for it, when there is one for this part, listing and revision. An answer of another revision does not hold. */
function withAnswer(part: string, l: EbayJudgedListing, answers: Map<string, EbayOwnerAnswer>): EbayJudgedListing {
  const { owner: _o, ownerAt: _at, ...bare } = l;
  const answer = answers.get(ebayAnswerKey(part, l.itemId, l.revision));
  return answer ? { ...bare, owner: answer.owner, ownerAt: answer.ownerAt } : bare;
}

const NO_USAGE = { inputTokens: 0, outputTokens: 0 };

/** Why a judged answer is what it is, as sentences: the model's own reason, then every check that lowered it. */
function reasonsOf(outcome: Extract<JudgeOutcome, { kind: 'judged' }>): string[] {
  const own = outcome.raw?.reason?.trim();
  return [...(own ? [own] : []), ...outcome.downgrades];
}

type Stop = 'ebay' | 'judge' | null;

export async function runEbayPass(a: EbayPassArgs): Promise<void> {
  const { store, job, parts, ebay, judge, now } = a;
  const counts = job.counts;
  const num = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const judgedCap = Math.max(0, Math.min(MAX_LISTINGS_JUDGED_PER_SCAN, Math.floor(a.listingsJudgedPerScan)));
  let stop: Stop = null;
  let judgeCapHit = false;
  // The owner's answers are their own records: whatever happens to a part's check, they are applied to the value it makes.
  const answers = new Map((await store.listEbayAnswers()).map((r) => [r.key, r] as const));
  const timeoutMs = a.callTimeoutMs ?? JUDGE_CALL_TIMEOUT_MS;

  /** An error from eBay: does it end the step? */
  const ebayFailed = (err: unknown): boolean => {
    if (err instanceof EbayAuthError) { noteEbay(job, NOTICE.ebayKeys); return true; }
    if (err instanceof EbayForbiddenError) { noteEbay(job, NOTICE.ebayForbidden); return true; }
    if (err instanceof EbayRateLimitedError) { noteEbay(job, NOTICE.ebayLimited); return true; }
    if (err instanceof EbayCapError) { noteEbay(job, err.kind === 'searches' ? NOTICE.searches : NOTICE.reads); return true; }
    return false;
  };

  for (const part of parts) {
    if (stop !== null || judgeCapHit || a.shouldStop()) break;
    if (num(counts.ebaySearches) >= EBAY_SEARCHES_MAX) { noteEbay(job, NOTICE.searches); break; }

    counts.ebaySearches = num(counts.ebaySearches) + 1;
    // Saved before the call: after an eviction the count already includes it, so a cap cannot be exceeded.
    await a.save();
    let searched: EbaySearchResult;
    try {
      searched = await ebay.search(`${part.brand} ${part.model}`, { categoryIds: [POWER_TOOLS_CATEGORY], conditionNew: true, fixedPrice: true, limit: 200 });
    } catch (err) {
      // A search that failed for another reason leaves the part as it was: it is asked for again next scan.
      if (ebayFailed(err)) stop = 'ebay';
      await a.save();
      continue;
    }
    const kept = preFilter({ brand: part.brand, model: part.model }, searched.summaries).kept;

    const before = await store.getEbayValue(part.key);
    const name = await nameOf(store, part);
    const twin = twinOf(part.brand, part.model);
    const judgedNow = new Map<string, EbayJudgedListing>();
    let notJudged = 0;

    for (const [i, summary] of kept.entries()) {
      if (stop !== null || a.shouldStop()) { notJudged += kept.length - i; break; }
      if (num(counts.ebayItemReads) >= EBAY_ITEM_READS_MAX) { noteEbay(job, NOTICE.reads); stop = 'ebay'; notJudged += kept.length - i; break; }
      counts.ebayItemReads = num(counts.ebayItemReads) + 1;
      await a.save();
      let item: EbayListing;
      try {
        item = await ebay.getItem(summary.itemId);
      } catch (err) {
        notJudged += 1;
        if (ebayFailed(err)) { stop = 'ebay'; notJudged += kept.length - i - 1; break; }
        continue;
      }

      const input: JudgeInput = { part: { brand: part.brand, model: part.model, ...(twin ? { twin } : {}), ...(name ? { title: name } : {}) }, listing: judgeListingFromEbay(item) };
      const key = judgementKey(item.itemId, item.revision, PROMPT_VERSION, judge.model, part.key, twin, name);
      // A saved answer is verified again on every read: the checks change without a prompt version change.
      const saved = await store.getJudgement(key);
      let call: JudgeCall;
      if (saved) {
        call = { judgeId: judge.id, model: judge.model, promptVersion: PROMPT_VERSION, ok: true, answer: saved.answer, usage: NO_USAGE };
      } else if (num(counts.listingsJudged) >= judgedCap) {
        // Not asked: the limit is the owner's cost cap. Later listings with a saved answer are still used.
        judgeCapHit = true;
        notJudged += 1;
        continue;
      } else {
        counts.listingsJudged = num(counts.listingsJudged) + 1;
        await a.save();
        try {
          call = await judge.judge(input, a.signal ? AbortSignal.any([a.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));
        } catch {
          // An adapter must not throw (ListingJudge); one that does is a call with no answer, never a verdict.
          call = { judgeId: judge.id, model: judge.model, promptVersion: PROMPT_VERSION, ok: false, notJudged: { reason: 'bad_response', message: 'The judge failed without an answer.' } };
        }
        if (call.usage) {
          counts.judgeTokensIn = num(counts.judgeTokensIn) + call.usage.inputTokens;
          counts.judgeTokensOut = num(counts.judgeTokensOut) + call.usage.outputTokens;
          await a.save();
        }
        if (call.ok) {
          await store.putJudgement({
            key, itemId: item.itemId, revision: item.revision ?? '', promptVersion: PROMPT_VERSION, model: judge.model, part: part.key,
            answer: call.answer, usage: { inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens }, judgedAt: now(),
          });
        } else {
          // Not judged: kept for this scan only, as a count, never as a verdict.
          notJudged += 1;
          const reason = call.notJudged.reason;
          if (reason === 'auth') { noteEbay(job, NOTICE.claudeKey); stop = 'judge'; notJudged += kept.length - i - 1; break; }
          if (reason === 'bad_request') { noteEbay(job, NOTICE.claudeRequest); stop = 'judge'; notJudged += kept.length - i - 1; break; }
          if (reason === 'rate_limited') { noteEbay(job, NOTICE.claudeLimited); stop = 'judge'; notJudged += kept.length - i - 1; break; }
          continue;
        }
      }

      const outcome = await judgeListing({ id: judge.id, model: judge.model, judge: async () => call }, input);
      if (outcome.kind !== 'judged') { notJudged += 1; continue; }
      judgedNow.set(item.itemId, {
        itemId: item.itemId, title: item.title, price: item.price, currency: item.currency, soldQuantity: item.soldQuantity, url: item.url,
        ...(item.revision ? { revision: item.revision } : {}),
        verdict: outcome.verdict, reasons: reasonsOf(outcome),
      });
    }

    // The part's listings in search order: each judged now, or (a check that stopped before it) as the last check left it.
    const listings: EbayJudgedListing[] = [];
    for (const s of kept) {
      const fresh = judgedNow.get(s.itemId) ?? before?.listings.find((l) => l.itemId === s.itemId);
      if (fresh) listings.push(withAnswer(part.key, fresh, answers));
    }

    if (judgeCapHit) noteEbay(job, NOTICE.judged(judgedCap));
    // Nothing of this part was judged (stopped, or every call failed): the part keeps what it had.
    if (kept.length > 0 && judgedNow.size === 0 && notJudged > 0) { await a.save(); continue; }
    const record: EbayValueRecord = {
      key: part.key, brand: part.brand, model: part.model, value: valueOf(listings), listings, notJudged, complete: notJudged === 0, checkedAt: now(),
    };
    await store.putEbayValue(record);
    await a.save();
  }
  await a.save();
}
