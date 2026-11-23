// "Paste a link, the price is found" (the owner, Nov 23). The Confirm a price sheet sends the pasted link here; the
// answer is a price to show him, never a price that counts: it counts when he presses Confirm (docs/decisions.md,
// "A price counts when he confirms it"). Three sites are read, each by the way that is already allowed:
//   eBay          the Browse API item call with his stored keys (free);
//   Amazon        one Keepa product pull by ASIN (1 token, through the token budget; Amazon itself is never browsed);
//   Home Depot    the product page read in his Chrome by the paired helper (free, the existing page job).
// Any other site is not read. Only USD prices are accepted. Whatever could not be read is `found: false` with a
// sentence, so he types the price himself; nothing is guessed (CLAUDE.md rule 4). Keys never leave the store and no
// sentence returned here can carry one (scrub).

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PriceFromLinkResponse } from '../core/src/api/contract';
import { EbayClient, EbayError } from '../core/src/ebay/client';
import { TokenBudget } from '../core/src/keepa/budget';
import { KeepaBudgetExceededError, KeepaClient, KeepaError } from '../core/src/keepa/client';
import { parseListingLink } from '../core/src/scan/listingLink';
import type { Cache } from '../core/src/serpapi/client';
import { type HdPace, pausedSentence } from '../core/src/scan/hdPace';
import { remoteReaders, NO_ANSWER } from './remoteReaders';
import type { Store, StoredKeys } from './store';
import type { WorkerJobs } from './workerJobs';
import { extensionSettingsOf, scrub } from './work';

/** How long one read may take, eBay, Keepa or Chrome. */
export const LINK_READ_MS = 15_000;

export const OTHER_SITE = 'Split Finder cannot read this site. Type the price you see.';
export const CHROME_CLOSED = 'Open Chrome and try again.';
const TYPE_IT = 'Type the price you see.';

export interface PriceFromLinkDeps {
  store: Store;
  jobs: WorkerJobs;
  dataDir: string;
  now: () => number;
  fetchFn: typeof fetch;
  helperConnected: () => boolean;
  /** The agent's Keepa cache: a pull made in the last hour is reused (and said to be from when it was read). */
  cache: Cache;
  timeoutMs?: number;
  /** Home Depot's pace for one page the owner asked for (mode 'owner': the gap and the cool-down, no cap). Absent: none. */
  pace?: Pick<HdPace, 'take' | 'pausedUntil'>;
}

const no = (reason: string): PriceFromLinkResponse => ({ found: false, reason });

export async function priceFromLink(deps: PriceFromLinkDeps, url: string): Promise<PriceFromLinkResponse> {
  const link = parseListingLink(url);
  const keys = deps.store.get('keys');
  const ms = deps.timeoutMs ?? LINK_READ_MS;
  const withTimeout: typeof fetch = (input, init) => deps.fetchFn(input, { ...init, signal: AbortSignal.timeout(ms) });
  try {
    if (link.site === 'ebay') return await fromEbay(deps, keys, link.id, withTimeout);
    if (link.site === 'amazon') return await fromAmazon(deps, keys, link.id, withTimeout);
    if (link.site === 'homedepot') return await fromHomeDepot(deps, link.id, url.trim(), ms);
    return no(OTHER_SITE);
  } catch (err) {
    return no(`${scrub(err instanceof Error && err.message ? err.message : 'Something went wrong.', keys)} ${TYPE_IT}`);
  }
}

type Keys = StoredKeys;

// ---------------------------------------------------------------- eBay

async function fromEbay(deps: PriceFromLinkDeps, keys: Keys, id: string | undefined, fetchFn: typeof fetch): Promise<PriceFromLinkResponse> {
  if (!id) return no(`That eBay link does not name one listing. ${TYPE_IT}`);
  if (!keys.ebay?.appId || !keys.ebay.certId) return no(`Add your eBay keys in Settings to read eBay prices. ${TYPE_IT}`);
  const client = new EbayClient({ appId: keys.ebay.appId, certId: keys.ebay.certId, fetchFn, now: deps.now });
  let offer;
  try {
    offer = await client.getOfferByLegacyId(id);
  } catch (err) {
    if (err instanceof EbayError && err.status === 404) return no('eBay has no listing with that number. It may have ended.');
    if (err instanceof EbayError && err.status === 400) return no(`eBay would not give one price for that listing (it may have options to choose). ${TYPE_IT}`);
    if (err instanceof EbayError && err.status === undefined && /network/i.test(err.message)) return no(`Could not reach eBay in time. ${TYPE_IT}`);
    throw err;
  }
  if (offer.ended) return no('This eBay listing has ended.');
  if (offer.auctionOnly) return no(`This is an auction. Its current bid is not a price you can buy at. ${TYPE_IT}`);
  if (offer.price === null || !(offer.price > 0)) return no(`eBay shows no price for this listing. ${TYPE_IT}`);
  if (offer.currency !== 'USD') return no(`This listing is priced in ${/^[A-Z]{3}$/.test(offer.currency) ? offer.currency : 'another currency'}. Split Finder confirms USD prices only. ${TYPE_IT}`);
  return {
    found: true,
    price: offer.price,
    currency: 'USD',
    title: offer.title,
    ...(offer.condition ? { condition: offer.condition } : {}),
    shipping: offer.shipping,
    source: 'eBay',
    url: offer.url || `https://www.ebay.com/itm/${id}`,
    readAt: new Date(deps.now()).toISOString(),
  };
}

// ---------------------------------------------------------------- Amazon (Keepa)

async function fromAmazon(deps: PriceFromLinkDeps, keys: Keys, asin: string | undefined, fetchFn: typeof fetch): Promise<PriceFromLinkResponse> {
  if (!asin) return no(`That Amazon link does not name one product. ${TYPE_IT}`);
  if (!keys.keepa) return no(`Add your Keepa key in Settings to read Amazon prices. ${TYPE_IT}`);
  const { keepaReserve } = extensionSettingsOf(deps.store.get('settings'));
  const budget = new TokenBudget({ reserve: keepaReserve, maxPerRun: Number.POSITIVE_INFINITY }, deps.store.get('runtime').keepa?.tokensLeft ?? null);
  const client = new KeepaClient({
    apiKey: keys.keepa, budget, cache: deps.cache, fetchFn, now: deps.now,
    onSpend: (entry) => {
      try {
        appendFileSync(join(deps.dataDir, 'keepa-ledger.jsonl'), `${JSON.stringify(entry)}\n`);
      } catch {
        // The ledger is the record; the token balance is Keepa's.
      }
      deps.store.update('runtime', (r) => ({
        ...r, keepa: { tokensLeft: entry.tokensLeft, refillIn: entry.refillIn, refillRate: entry.refillRate ?? r.keepa?.refillRate, at: new Date(deps.now()).toISOString() },
      }));
    },
  });
  let result;
  try {
    result = await client.getProducts([asin], 1, { label: 'price from a pasted link', maxAgeMs: 60 * 60_000 });
  } catch (err) {
    if (err instanceof KeepaBudgetExceededError) return no(`Keepa has no tokens to spare right now. ${TYPE_IT}`);
    if (err instanceof KeepaError && err.status === 401) return no(`Keepa did not accept your key. Check it in Settings. ${TYPE_IT}`);
    if (err instanceof KeepaError && err.status === 429) return no(`Keepa has no tokens left right now. ${TYPE_IT}`);
    if (err instanceof KeepaError && /^Network error/.test(err.message)) return no(`Could not reach Keepa in time. ${TYPE_IT}`);
    throw err;
  }
  const product = result.data.products.find((p) => p.asin.toUpperCase() === asin);
  if (!product) return no(`Keepa does not know that Amazon product. ${TYPE_IT}`);
  const cents = product.amazonPrice;
  if (cents == null || !(cents > 0)) return no(`Amazon has no New price for it right now (Keepa shows none). ${TYPE_IT}`);
  const own = product.amazonPriceSource !== 'new_lowest';
  return {
    found: true,
    price: Math.round(cents) / 100,
    currency: 'USD',
    title: product.title?.trim() || asin,
    condition: 'New',
    source: 'Amazon (Keepa)',
    url: `https://www.amazon.com/dp/${asin}`,
    readAt: new Date(result.at).toISOString(),
    note: own ? 'Amazon’s own current price, from Keepa.' : 'The lowest current New offer, from Keepa. The Buy Box price can be higher.',
  };
}

// ---------------------------------------------------------------- Home Depot (his Chrome)

async function fromHomeDepot(deps: PriceFromLinkDeps, id: string | undefined, url: string, ms: number): Promise<PriceFromLinkResponse> {
  if (!id) return no(`That Home Depot link does not name one product. ${TYPE_IT}`);
  if (!deps.helperConnected()) return no(CHROME_CLOSED);
  // Home Depot's pace: after a refusal nothing is read until the cool-down ends, his own link included.
  const until = deps.pace?.pausedUntil() ?? null;
  if (until !== null) return no(`${pausedSentence(until)} ${TYPE_IT}`);
  const pace = deps.pace;
  const readers = remoteReaders({ jobs: deps.jobs, timeouts: { pageMs: ms, perItemMs: 0 }, ...(pace ? { gate: { take: (signal?: AbortSignal) => pace.take('owner', signal) } } : {}) });
  let outcomes;
  try {
    outcomes = await readers.readPromoPages([id]);
  } catch (err) {
    const said = err instanceof Error ? err.message : '';
    return no(said === NO_ANSWER || said === '' ? CHROME_CLOSED : `${said} ${TYPE_IT}`);
  }
  const outcome = outcomes.find((o) => o.itemId === id);
  if (!outcome) return no(`Chrome did not read that page. ${TYPE_IT}`);
  if (outcome.kind === 'refused') {
    const paused = deps.pace?.pausedUntil() ?? null;
    return no(paused !== null ? `Home Depot did not let the page open. ${pausedSentence(paused)} ${TYPE_IT}` : `Home Depot did not let the page open. Try again in a minute, or ${TYPE_IT.charAt(0).toLowerCase()}${TYPE_IT.slice(1)}`);
  }
  if (outcome.kind !== 'read') return no(`Chrome could not read that Home Depot page. ${TYPE_IT}`);
  const { price, title } = outcome.page;
  if (price === null || !(price > 0)) return no(`Home Depot shows no price on that page. ${TYPE_IT}`);
  return { found: true, price, currency: 'USD', title, source: 'Home Depot', url, readAt: new Date(deps.now()).toISOString() };
}

