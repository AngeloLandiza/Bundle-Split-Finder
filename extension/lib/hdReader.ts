// Reads Home Depot bundle pages from inside one background Home Depot tab, because Home Depot
// refuses the same requests from the service worker. Every Chrome call goes through ReaderEnv,
// so this file touches no chrome.* and is tested with fakes (see hdReader.test.ts).

import { parseBundlePage, parseProductPage } from '@core/hdPage';
import { modelForms, sameModel } from '@core/match';
import {
  PART_PRICE_READS_MAX, type PageOutcome, type PartPriceReading, type ReadPages, type ReadPartPrices as CoreReadPartPrices,
} from '@core/scan/types';

export interface ReaderEnv {
  /** 'https://www.homedepot.com', or the replay server in the end-to-end build. */
  origin: string;
  /** Opens a background tab; never focuses it. */
  openTab(url: string): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  /** Resolves when the tab has finished loading; rejects after timeoutMs. */
  waitForLoad(tabId: number, timeoutMs: number): Promise<void>;
  /** chrome.scripting.executeScript in the ISOLATED world; resolves with the function's result. */
  runInTab<A extends unknown[], R>(tabId: number, func: (...args: A) => Promise<R>, args: A): Promise<R>;
  /** chrome.storage.session, so a doorway left by a stopped worker can be closed. */
  remember(tabId: number | null): Promise<void>;
  remembered(): Promise<number | null>;
  sleep(ms: number): Promise<void>;
}

export interface InTabResult { itemId: string; status: number; text: string | null }

/** True once the doorway tab has finished loading a page on `origin`, never on its blank start page. */
export function doorwayLoaded(tab: { status?: string; url?: string }, origin: string): boolean {
  return tab.status === 'complete' && typeof tab.url === 'string' && tab.url.startsWith(`${origin}/`);
}

/**
 * Resolves once the doorway tab is complete on `origin`. It checks the tab every `everyMs`
 * instead of listening for Chrome's update event, which Chrome does not always deliver.
 * Rejects with Error('timeout') after `timeoutMs`; a failing `getTab` (the tab was closed) rejects at once.
 */
export async function waitForDoorway(
  getTab: (tabId: number) => Promise<{ status?: string; url?: string }>,
  tabId: number,
  origin: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
  everyMs = 250,
): Promise<void> {
  const until = now() + timeoutMs;
  for (;;) {
    if (doorwayLoaded(await getTab(tabId), origin)) return;
    if (now() >= until) throw new Error('timeout');
    await sleep(everyMs);
  }
}

/**
 * Runs inside the tab. Self-contained: no imports, no outside variables, no nested named
 * functions (it is serialised by its source). Fetches `/p/<id>` same-origin, `concurrency` at a
 * time, and returns the text from `window.__APOLLO_STATE__=` to the next `</script>`, or null.
 * Results are in the order of `itemIds`. A fetch that throws gives status 0. It starts no new
 * fetch after the first answer that is not the page (non-200, a thrown fetch, or no embedded
 * data); ids it never fetched come back with status -1.
 */
export async function fetchPagesInTab(itemIds: string[], concurrency: number): Promise<InTabResult[]> {
  const results: InTabResult[] = new Array(itemIds.length);
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (next < itemIds.length) {
      const i = next++;
      const itemId = itemIds[i] as string;
      if (stopped) {
        // Never fetched, because an earlier page was refused.
        results[i] = { itemId, status: -1, text: null };
        continue;
      }
      let status = 0;
      let text: string | null = null;
      try {
        const res = await fetch(`/p/${itemId}`, { credentials: 'include' });
        status = res.status;
        const body = await res.text();
        const mark = body.indexOf('window.__APOLLO_STATE__=');
        if (mark >= 0) {
          const end = body.indexOf('</script>', mark);
          text = end >= 0 ? body.slice(mark, end) : body.slice(mark);
        }
      } catch {
        status = 0;
        text = null;
      }
      if (status !== 200 || text === null) stopped = true;
      results[i] = { itemId, status, text };
    }
  };
  const n = Math.max(1, Math.min(concurrency, itemIds.length));
  const workers: Promise<void>[] = [];
  for (let k = 0; k < n; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

const LOAD_TIMEOUT_MS = 30_000;

/**
 * `settleMs` is waited once after the doorway tab has loaded, before the first fetch.
 * `pauseMs` is waited between two batches, and before a call that starts within `pauseMs` of the
 * end of this reader's last call (a scan reads bundle pages, then kit pages, at once), only for
 * what is left of it. `now` is the clock for that, injected in tests.
 */
export function createPageReader(
  env: ReaderEnv,
  opts: { concurrency?: number; batch?: number; pauseMs?: number; settleMs?: number; now?: () => number } = {},
): ReadPages {
  const concurrency = opts.concurrency ?? 3;
  const batch = opts.batch ?? 6;
  const pauseMs = opts.pauseMs ?? 1000;
  const settleMs = opts.settleMs ?? 2500;
  const now = opts.now ?? Date.now;
  // When this reader's last call ended; null before its first.
  let lastEnded: number | null = null;

  return async (itemIds: string[]): Promise<PageOutcome[]> => {
    if (itemIds.length === 0) return [];
    if (lastEnded !== null) {
      const left = pauseMs - (now() - lastEnded);
      if (left > 0) await env.sleep(left);
    }

    // A doorway left by a worker that was stopped mid-scan.
    const left = await env.remembered();
    if (left !== null) {
      await env.closeTab(left).catch(() => undefined);
      await env.remember(null);
    }

    const tabId = await env.openTab(`${env.origin}/p/${itemIds[0]}`);
    try {
      await env.remember(tabId);
      try {
        await env.waitForLoad(tabId, LOAD_TIMEOUT_MS);
      } catch {
        throw new Error('The Home Depot tab did not load.');
      }
      // Home Depot's own page has not always settled when the tab reports complete (a cold session answered
      // the first scan's fetches with a refusal). Wait once, then fetch; a refusal is still not retried.
      if (settleMs > 0) await env.sleep(settleMs);

      const outcomes: PageOutcome[] = [];
      let stopped = false;
      for (let start = 0; start < itemIds.length; start += batch) {
        const ids = itemIds.slice(start, start + batch);
        if (stopped) {
          for (const itemId of ids) outcomes.push({ itemId, kind: 'skipped' });
          continue;
        }
        if (start > 0) await env.sleep(pauseMs);
        const answered = await env.runInTab(tabId, fetchPagesInTab, [ids, concurrency]);
        // An empty script result (undefined, not an array) is a batch with no entries.
        const results: InTabResult[] = Array.isArray(answered) ? answered : [];
        for (const itemId of ids) {
          if (stopped) {
            outcomes.push({ itemId, kind: 'skipped' });
            continue;
          }
          const r = results.find((x) => x.itemId === itemId);
          if (r && r.status === -1) {
            outcomes.push({ itemId, kind: 'skipped' });
            continue;
          }
          if (!r || r.status !== 200 || r.text === null) {
            stopped = true;
            // status 0: the fetch threw, or the script gave no answer for this id.
            outcomes.push({ itemId, kind: 'refused', status: r ? r.status : 0 });
            continue;
          }
          const content = parseBundlePage(r.text, itemId);
          outcomes.push(content ? { itemId, kind: 'read', content } : { itemId, kind: 'unreadable' });
        }
      }
      return outcomes;
    } finally {
      await env.closeTab(tabId).catch(() => undefined);
      await env.remember(null).catch(() => undefined);
      lastEnded = now();
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Part prices (step 9, Phase 1): what Home Depot charges for one part sold alone. Same doorway, same pause, same
// refusal rule as createPageReader; the part's item id comes from Home Depot's own search, never from a guess.

/**
 * What one part's lookup gave: core's PartPriceReading.
 * found      the search showed a product whose address ends with the model (or the RYOBI twin), and its page names
 *            the part's brand, a sameModel model (`matchedModel`) and a price
 * not_found  the search answered and showed no such product, or its page named another brand or model (every figure
 *            null), or the confirmed page named no price (`itemId`, `matchedModel`, `title` and `link` kept, `price` null)
 * not_read   never looked up: past the cap, after a refusal, a blank model, or a page that could not be parsed (every
 *            figure null)
 */
export type PartPriceRead = PartPriceReading;

/** The scan dependency of the step 9 contract (core's ReadPartPrices): one entry per part asked for, in order. */
export type ReadPartPrices = CoreReadPartPrices;

export interface SearchInTab {
  model: string;
  status: number;
  /** `/p/<slug>/<9-digit id>` paths on the search page, in page order. Null unless status is 200. */
  links: string[] | null;
}

/**
 * Runs inside the tab. Self-contained, like fetchPagesInTab (serialised by its source). Fetches Home Depot's own
 * `/s/<model>` same-origin, `concurrency` at a time, and returns the product links each page holds. A search that
 * Home Depot sent straight to one product also gives that product's own address. A fetch that throws gives status 0.
 * It starts no new fetch after the first answer that is not 200 (or a thrown fetch); models it never fetched come
 * back with status -1. A 200 page with no product link is a search with no result, not a refusal.
 */
export async function fetchSearchesInTab(models: string[], concurrency: number): Promise<SearchInTab[]> {
  const results: SearchInTab[] = new Array(models.length);
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (next < models.length) {
      const i = next++;
      const model = models[i] as string;
      if (stopped) {
        results[i] = { model, status: -1, links: null };
        continue;
      }
      let status = 0;
      let links: string[] | null = null;
      try {
        const res = await fetch(`/s/${encodeURIComponent(model)}`, { credentials: 'include' });
        status = res.status;
        const body = await res.text();
        if (status === 200) {
          const found: string[] = [];
          const seen: Record<string, boolean> = {};
          const pattern = /\/p\/([A-Za-z0-9._~%+-]+)\/(\d{9})(?![0-9])/g;
          const sources = [new URL(res.url, location.href).pathname, body];
          for (const source of sources) {
            pattern.lastIndex = 0;
            let m = pattern.exec(source);
            while (m !== null && found.length < 80) {
              const path = `/p/${m[1]}/${m[2]}`;
              if (!seen[path]) {
                seen[path] = true;
                found.push(path);
              }
              m = pattern.exec(source);
            }
          }
          links = found;
        }
      } catch {
        status = 0;
        links = null;
      }
      if (status !== 200) stopped = true;
      results[i] = { model, status, links };
    }
  };
  const n = Math.max(1, Math.min(concurrency, models.length));
  const workers: Promise<void>[] = [];
  for (let k = 0; k < n; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * The one product a search shows for a part: the first link whose address ends with `-<MODEL>` (case-insensitive),
 * as Home Depot writes `/p/<slug>-<MODEL>/<id>`. For RYOBI the model's other form (PCL206 for PCL206B and back, the
 * rule of core's sameModel and Ruling 70) is accepted too, and an exact match is preferred when both appear. A
 * longer model that merely ends with this one matches here; the product's own page is what rules it out.
 */
export function pickPartLink(brand: string, model: string, links: string[]): { itemId: string; path: string } | null {
  for (const form of modelForms(brand, model)) {
    const tail = `-${form}`;
    for (const path of links) {
      const m = /^\/p\/([^/]+)\/(\d{9})$/.exec(path);
      if (m && (m[1] as string).toUpperCase().endsWith(tail)) return { itemId: m[2] as string, path };
    }
  }
  return null;
}

type PartAsked = { brand: string; model: string };
const emptyRead = (p: PartAsked, status: 'not_found' | 'not_read' = 'not_read'): PartPriceRead => ({
  brand: p.brand, model: p.model, status, itemId: null, matchedModel: null, price: null, title: null, link: null,
});
const partKeyOf = (p: PartAsked): string => `${p.brand.trim().toUpperCase()}:${p.model.trim().toUpperCase()}`;

/**
 * Reads Home Depot's standalone price for each part, free, inside one doorway tab: its own search `/s/<MODEL>`,
 * then the chosen product's page `/p/<id>`, read with parseProductPage. A product whose page does not name the
 * part's brand and model (sameModel) gives nothing: an id is never guessed.
 * `cap` is the most distinct parts one call looks up, by default PART_PRICE_READS_MAX, the most the scan asks for (the
 * rest come back not_read); `pauseMs` and `settleMs` as for createPageReader. A non-200 answer, a thrown fetch, or a
 * product page with no embedded data stops the call: that part comes back not_read, and so does every part not yet
 * read. Each reading's status says which (PartPriceRead).
 */
export function createPartPriceReader(
  env: ReaderEnv,
  opts: { concurrency?: number; batch?: number; cap?: number; pauseMs?: number; settleMs?: number; now?: () => number } = {},
): ReadPartPrices {
  const concurrency = opts.concurrency ?? 2;
  const batch = opts.batch ?? 4;
  const cap = opts.cap ?? PART_PRICE_READS_MAX;
  const pauseMs = opts.pauseMs ?? 1000;
  const settleMs = opts.settleMs ?? 2500;
  const now = opts.now ?? Date.now;
  let lastEnded: number | null = null;

  return async (asked) => {
    // One lookup per distinct part; every part asked for gets its answer back, in order.
    const distinct: PartAsked[] = [];
    const seenKeys = new Set<string>();
    for (const p of asked) {
      if (p.model.trim() === '' || seenKeys.has(partKeyOf(p))) continue;
      seenKeys.add(partKeyOf(p));
      distinct.push(p);
    }
    const parts = distinct.slice(0, Math.max(0, cap));
    const first = parts[0];
    if (first === undefined) return asked.map((p) => emptyRead(p));

    if (lastEnded !== null) {
      const left = pauseMs - (now() - lastEnded);
      if (left > 0) await env.sleep(left);
    }
    const left = await env.remembered();
    if (left !== null) {
      await env.closeTab(left).catch(() => undefined);
      await env.remember(null);
    }

    const answers = new Map<string, PartPriceRead>();
    const tabId = await env.openTab(`${env.origin}/s/${encodeURIComponent(first.model)}`);
    try {
      await env.remember(tabId);
      try {
        await env.waitForLoad(tabId, LOAD_TIMEOUT_MS);
      } catch {
        throw new Error('The Home Depot tab did not load.');
      }
      if (settleMs > 0) await env.sleep(settleMs);

      let calls = 0;
      const pause = async (): Promise<void> => {
        if (calls++ > 0) await env.sleep(pauseMs);
      };
      let stopped = false;
      for (let start = 0; start < parts.length && !stopped; start += batch) {
        const group = parts.slice(start, start + batch);
        await pause();
        const found = await env.runInTab(tabId, fetchSearchesInTab, [group.map((p) => p.model), concurrency]);
        // An empty script result (undefined, not an array) is a batch with no entries.
        const searches: SearchInTab[] = Array.isArray(found) ? found : [];
        const answeredFor = (p: PartAsked) => searches.find((x) => x.model === p.model);
        // Any part whose search was not answered 200 is a refusal; no page is fetched after it.
        if (group.some((p) => { const s = answeredFor(p); return !s || (s.status !== 200 && s.status !== -1); })) stopped = true;
        const chosen: { part: PartAsked; itemId: string; path: string }[] = [];
        for (const part of group) {
          const s = answeredFor(part);
          if (s && s.status === 200 && s.links !== null) {
            const pick = pickPartLink(part.brand, part.model, s.links);
            // Home Depot answered and showed no product for the model: not found, even if a later search is refused.
            if (pick) chosen.push({ part, ...pick });
            else answers.set(partKeyOf(part), emptyRead(part, 'not_found'));
          }
        }
        if (stopped || chosen.length === 0) continue;

        await pause();
        const fetched = await env.runInTab(tabId, fetchPagesInTab, [chosen.map((c) => c.itemId), concurrency]);
        const pages: InTabResult[] = Array.isArray(fetched) ? fetched : [];
        for (const c of chosen) {
          const r = pages.find((x) => x.itemId === c.itemId);
          if (r && r.status === -1) continue;
          if (!r || r.status !== 200 || r.text === null) {
            stopped = true;
            continue;
          }
          const page = parseProductPage(r.text, c.itemId);
          // A page whose data could not be parsed says nothing: not read.
          if (page === null) continue;
          // The product the search showed is not the part (a kit whose address ends with the model, another brand).
          if (page.brand.toUpperCase() !== c.part.brand.trim().toUpperCase() || !sameModel(c.part.brand, page.model, c.part.model)) {
            answers.set(partKeyOf(c.part), emptyRead(c.part, 'not_found'));
            continue;
          }
          answers.set(partKeyOf(c.part), {
            brand: c.part.brand,
            model: c.part.model,
            // A confirmed page with no price: Home Depot has no price for the part sold alone.
            status: page.price === null ? 'not_found' : 'found',
            itemId: c.itemId,
            matchedModel: page.model.trim(),
            price: page.price,
            title: page.title === '' ? null : page.title,
            link: `${env.origin}${c.path}`,
          });
        }
      }
    } finally {
      await env.closeTab(tabId).catch(() => undefined);
      await env.remember(null).catch(() => undefined);
      lastEnded = now();
    }
    return asked.map((p) => ({ ...(answers.get(partKeyOf(p)) ?? emptyRead(p)), brand: p.brand, model: p.model }));
  };
}
