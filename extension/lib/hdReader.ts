// Reads Home Depot bundle pages from inside one background Home Depot tab, because Home Depot
// refuses the same requests from the service worker. Every Chrome call goes through ReaderEnv,
// so this file touches no chrome.* and is tested with fakes (see hdReader.test.ts).

import { parseBundlePage } from '@core/hdPage';
import type { PageOutcome, ReadPages } from '@core/scan/types';

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

/**
 * Runs inside the tab. Self-contained: no imports, no outside variables, no nested named
 * functions (it is serialised by its source). Fetches `/p/<id>` same-origin, `concurrency` at a
 * time, and returns the text from `window.__APOLLO_STATE__=` to the next `</script>`, or null.
 * Results are in the order of `itemIds`. A fetch that throws gives status 0.
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

export function createPageReader(
  env: ReaderEnv,
  opts: { concurrency?: number; batch?: number; pauseMs?: number } = {},
): ReadPages {
  const concurrency = opts.concurrency ?? 3;
  const batch = opts.batch ?? 6;
  const pauseMs = opts.pauseMs ?? 1000;

  return async (itemIds: string[]): Promise<PageOutcome[]> => {
    if (itemIds.length === 0) return [];

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

      const outcomes: PageOutcome[] = [];
      let stopped = false;
      for (let start = 0; start < itemIds.length; start += batch) {
        const ids = itemIds.slice(start, start + batch);
        if (stopped) {
          for (const itemId of ids) outcomes.push({ itemId, kind: 'skipped' });
          continue;
        }
        if (start > 0) await env.sleep(pauseMs);
        const results = await env.runInTab(tabId, fetchPagesInTab, [ids, concurrency]);
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
            outcomes.push({ itemId, kind: 'refused' });
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
    }
  };
}
