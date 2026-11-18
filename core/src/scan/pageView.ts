// A Home Depot product page the owner has open (step 7): the chip on the page and the side panel's
// This page tab show it. Its bundle is stored, split and matched from saved listings by the scan's
// own steps (splitOne, savedMatch), and its row is the report's (reportRow), so a page visit and a
// scan never differ. Never a search: the only client here refuses, and no scan job is read or written.

import type { ProductPage } from '../hdPage';
import { choicesOf } from './answers';
import { looksLikeBundle } from './classify';
import { OverlayStore } from './overlayStore';
import { lookupsNeeded, noCounts, savedAnswers } from './paid';
import { notLookedUp, reportRow } from './report';
import { bundleParts, type PartContext, savedMatch, splitOne } from './runner';
import { knownModels } from './split';
import { type BundleRecord, type BundleRow, bundleKey, type ReviewItem, type ScanSettings, type ScanStore, type SearchClient } from './types';

export type PageView =
  | { kind: 'none' }
  | {
    kind: 'bundle';
    /** bundleKey(itemId). */
    key: string;
    itemId: string;
    model: string;
    /** Units in the row's parts (its primary way to sell), each part counted by its qty; 0 while the split needs an answer. */
    parts: number;
    /** The report's row, with the page's price when the page shows one: it is what the owner sees. */
    row: BundleRow;
    /**
     * The searches a Look up of the row's parts not looked up yet would need (lookupsNeeded), before the
     * per-scan limit and the account's budget, which a page visit never checks; 0 when none waits.
     */
    lookupParts: number;
    /** The bundle's open split question (`split:` and its key) while its split needs an answer; null otherwise. */
    question: ReviewItem | null;
  };

export interface NotePageOptions {
  /**
   * Default true. False: the same view, computed over a copy-on-write layer on the store (OverlayStore),
   * whose writes are dropped, so the store is not written at all. The worker asks for it while a scan or
   * a panel action runs, as those write the same records.
   */
  write?: boolean;
}

const NONE: PageView = { kind: 'none' };

/** A Home Depot item id is digits. The page comes from a content script, and the id goes into a link. */
const ITEM_ID = /^\d+$/;

/** A page visit never searches: a search asked for here is a bug, and is refused before it is sent. */
const NO_SEARCH: SearchClient = {
  search: () => Promise.reject(new Error('A product page is never searched for.')),
};

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isPrice = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0);

/** True for a ProductPage as parseProductPage gives one. Anything else (the message is untrusted) is no page. */
function wellFormed(page: unknown): page is ProductPage {
  if (typeof page !== 'object' || page === null) return false;
  const p = page as Record<string, unknown>;
  return typeof p.itemId === 'string' && ITEM_ID.test(p.itemId) && isText(p.brand) && isText(p.model) && typeof p.title === 'string'
    && isPrice(p.price) && isPrice(p.wasPrice) && Array.isArray(p.bullets) && p.bullets.every((b) => typeof b === 'string')
    && (p.description === null || typeof p.description === 'string');
}

/** Percent off the was-price, rounded to a whole percent; null without a was-price above the price. */
const percentOff = (price: number | null, was: number | null): number | null =>
  price !== null && was !== null && was > price ? Math.round(((was - price) / was) * 100) : null;

/**
 * The bundle record after a visit at `now`, brand upper case and model trimmed (as a scan stores a
 * listing row's). The page's content is its reading (P2), unless a reading newer than the visit is
 * stored. A bundle already stored keeps its title, price, was-price, percent off and seenAt: those are
 * a listing's, and only a listing response changes them (Review Focus 3); the visit changes its brand
 * and model when they differ, its reading, and then its split. A new record takes the page's title and
 * price, seen at the visit; one from a page with no price is seen at 0, so any listing response with
 * its price replaces it (applyListing keeps a record only when it was seen later than the response).
 */
function visited(known: BundleRecord | undefined, page: ProductPage, brand: string, model: string, now: number): BundleRecord {
  const reading = { bullets: [...page.bullets], description: page.description, readAt: now };
  const content = known?.page && known.page.readAt > now ? known.page : reading;
  if (known) return { ...known, brand, model, page: content };
  return {
    key: bundleKey(page.itemId), retailer: 'homedepot', itemId: page.itemId, title: page.title.trim(), brand, model, upc: null,
    price: page.price, regularPrice: page.price === null ? null : page.wasPrice, percentOff: percentOff(page.price, page.wasPrice),
    link: `https://www.homedepot.com/p/${page.itemId}`, seenAt: page.price === null ? 0 : now, split: null, page: content,
  };
}

/**
 * A product page the owner has open, seen at `now`. None when its brand is not one `settings.brands`
 * scans, or its model has no bundle shape (looksLikeBundle): then nothing is written. Otherwise its
 * bundle record is stored from the page (visited: a stored bundle's price and title are never changed), split as a scan splits it, opening or following its
 * split question as a scan would (splitOne), and, when the split is resolved, its parts are matched
 * from saved listings as a scan matches them (savedMatch over bundleParts of this bundle alone). The
 * owner's answers and Verify's results stand, as they do in a scan. Nothing is searched for and no
 * scan job is touched; counts are not kept. With `write: false` all of it runs over an OverlayStore on
 * `target`, so the view is the same and `target` is not written.
 */
export async function notePage(
  target: ScanStore, settings: ScanSettings, page: ProductPage, now: number, opts: NotePageOptions = {},
): Promise<PageView> {
  if (!wellFormed(page)) return NONE;
  const brand = page.brand.trim().toUpperCase();
  const model = page.model.trim();
  if (!settings.brands.some((b) => b.trim().toUpperCase() === brand) || !looksLikeBundle(brand, model)) return NONE;
  const store = opts.write === false ? new OverlayStore(target) : target;

  const key = bundleKey(page.itemId);
  const known = await knownModels(store);
  const record = visited(await store.getBundle(key), page, brand, model, now);
  const { split } = await splitOne(store, record, known, now);

  if (split.status === 'resolved') {
    const ctx: PartContext = {
      client: NO_SEARCH, store, settings, now: () => now, prefix: 'page', catalog: known.catalog, job: { counts: noCounts() },
    };
    for (const part of (await bundleParts(store, (b) => b.key === key)).values()) await savedMatch(ctx, known.listings, part);
  }

  const stored = (await store.getBundle(key))!;
  // The page's price wins for the view only, whatever the record keeps: it is the price the owner sees.
  const shown: BundleRecord = page.price === null
    ? stored
    : { ...stored, price: page.price, regularPrice: page.wasPrice, percentOff: percentOff(page.price, page.wasPrice), seenAt: now };
  const row = await reportRow(store, settings, shown);
  const waiting = row.parts.filter(notLookedUp).map((p) => ({ brand: row.brand, model: p.model }));
  // The question splitOne left open, with its readings as Review shows them (an item saved before step 5 has none stored).
  const asked = split.status === 'resolved' ? undefined : await store.getReview(`split:${key}`);
  return {
    kind: 'bundle', key, itemId: page.itemId, model: row.model, parts: row.parts.reduce((n, p) => n + p.qty, 0), row,
    lookupParts: waiting.length === 0 ? 0 : lookupsNeeded(waiting, await savedAnswers(store)),
    question: asked && asked.answer === null ? { ...asked, choices: choicesOf(asked) } : null,
  };
}
