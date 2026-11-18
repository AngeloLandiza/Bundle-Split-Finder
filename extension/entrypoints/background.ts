// Wiring only: the real storage, network and Chrome APIs handed to the worker in lib/worker.ts.
// Listeners are registered synchronously in main, as an MV3 service worker requires.

import { browser } from 'wxt/browser';
import type { BundleRow } from '@core/scan/types';
import { IdbCache } from '../lib/idbCache';
import { IdbScanStore } from '../lib/idbStore';
import { appendLedger } from '../lib/ledger';
import { CONTENT_REQUESTS, type ChipSetting, type Request, type ShowThisPage, type StateChanged } from '../lib/messages';
import * as prefs from '../lib/prefs';
import { mayAsk } from '../lib/sender';
import { createPageReader, waitForDoorway, type ReaderEnv } from '../lib/hdReader';
import { createWorker, type DeferredPage, type PageEnv } from '../lib/worker';
import type { ProductPage } from '../../core/src/hdPage';

declare const __SPLIT_FINDER_BASE_URL__: string | undefined;
declare const __SPLIT_FINDER_HD_ORIGIN__: string;
declare const __SPLIT_FINDER_DEBUG__: boolean;

const DOORWAY_KEY = 'hdReaderTab';

/** The reader's Chrome calls. Opening a background tab needs no permission. */
function chromeReaderEnv(): ReaderEnv {
  return {
    origin: __SPLIT_FINDER_HD_ORIGIN__,
    async openTab(url) {
      // Opened blank and remembered before it goes to the page, so the chip's content script (which runs on that page)
      // finds the tab already named as the reader's when it sends its first pageSeen. waitForDoorway never takes the
      // blank start page for the loaded one (doorwayLoaded).
      const tab = await browser.tabs.create({ url: 'about:blank', active: false });
      if (typeof tab.id !== 'number') throw new Error('Chrome opened no tab.');
      await browser.storage.session.set({ [DOORWAY_KEY]: tab.id });
      await browser.tabs.update(tab.id, { url });
      return tab.id;
    },
    async closeTab(tabId) {
      await browser.tabs.remove(tabId);
    },
    waitForLoad(tabId, timeoutMs) {
      return waitForDoorway((id) => browser.tabs.get(id), tabId, __SPLIT_FINDER_HD_ORIGIN__, timeoutMs, (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    },
    async runInTab(tabId, func, args) {
      const results = await browser.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func, args });
      return results[0]?.result as Awaited<ReturnType<typeof func>>;
    },
    async remember(tabId) {
      if (tabId === null) await browser.storage.session.remove(DOORWAY_KEY);
      else await browser.storage.session.set({ [DOORWAY_KEY]: tabId });
    },
    async remembered() {
      const got = await browser.storage.session.get(DOORWAY_KEY);
      const v = got[DOORWAY_KEY];
      return typeof v === 'number' ? v : null;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * What each tab's Home Depot page was, and whether the chip asked for the panel to open on This page, in
 * chrome.storage.session: it outlives the service worker and is gone when the browser closes. One key per tab and
 * kind, so no write reads another's value.
 */
const pageKey = (tabId: number) => `thisPage:${tabId}`;
const wantedKey = (tabId: number) => `showThisPage:${tabId}`;
const chipTabKey = (tabId: number) => `chipTab:${tabId}`;
const deferredKey = (tabId: number) => `deferred:${tabId}`;

function chromePages(): PageEnv {
  return {
    async load(tabId) {
      const v = (await browser.storage.session.get(pageKey(tabId)))[pageKey(tabId)];
      return typeof v === 'object' && v !== null ? (v as ProductPage) : null;
    },
    async save(tabId, page) {
      if (page === null) await browser.storage.session.remove(pageKey(tabId));
      else await browser.storage.session.set({ [pageKey(tabId)]: page });
    },
    async setDeferred(tabId, entry) {
      if (entry === null) await browser.storage.session.remove(deferredKey(tabId));
      else await browser.storage.session.set({ [deferredKey(tabId)]: entry });
    },
    async deferredAll() {
      const all = await browser.storage.session.get(null);
      return Object.entries(all)
        .filter(([k, v]) => k.startsWith('deferred:') && typeof v === 'object' && v !== null)
        .map(([k, v]) => ({ tabId: Number(k.slice('deferred:'.length)), ...(v as DeferredPage) }))
        .filter((d) => Number.isInteger(d.tabId) && typeof d.seenAt === 'number');
    },
    async setWanted(tabId, on) {
      if (on) await browser.storage.session.set({ [wantedKey(tabId)]: true });
      else await browser.storage.session.remove(wantedKey(tabId));
    },
    async wanted(tabId) {
      return (await browser.storage.session.get(wantedKey(tabId)))[wantedKey(tabId)] === true;
    },
    // Chrome 116+. Only in answer to a user action, which the chip's click is.
    openPanel: (tabId) => browser.sidePanel.open({ tabId }),
    tell(tabId) {
      browser.runtime.sendMessage({ type: 'showThisPage', tabId } satisfies ShowThisPage).catch(() => {});
    },
    async isReaderTab(tabId) {
      return (await browser.storage.session.get(DOORWAY_KEY))[DOORWAY_KEY] === tabId;
    },
    async chipTabs() {
      const all = await browser.storage.session.get(null);
      return Object.keys(all)
        .filter((k) => k.startsWith('chipTab:'))
        .map((k) => Number(k.slice('chipTab:'.length)))
        .filter((n) => Number.isInteger(n));
    },
    async setChipTab(tabId, on) {
      if (on) await browser.storage.session.set({ [chipTabKey(tabId)]: true });
      else await browser.storage.session.remove(chipTabKey(tabId));
    },
    async sendChipSetting(tabId, show) {
      await browser.tabs.sendMessage(tabId, { type: 'chipSetting', show } satisfies ChipSetting);
    },
  };
}

const TICK = 'tick';
/** Notifications need an icon; until the extension has one, a plain square in --ink. */
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQkpEDAACoAFUlVprSAAAAAElFTkSuQmCC';

/** One notification per bundle. The profit is an estimate and says so. */
async function notify(rows: BundleRow[]): Promise<void> {
  for (const row of rows) {
    if (row.estimate === null) continue;
    await browser.notifications.create({
      type: 'basic',
      iconUrl: ICON,
      title: 'Split Finder',
      message: `${row.model} · estimated profit $${row.estimate.profit.toFixed(2)}`,
    });
  }
}

export default defineBackground(() => {
  const readPages = createPageReader(chromeReaderEnv(), {
    // The end-to-end build reads from the local replay server, which needs no settling.
    settleMs: __SPLIT_FINDER_BASE_URL__ === undefined ? undefined : 50,
  });
  if (__SPLIT_FINDER_DEBUG__) (globalThis as { splitFinderReadPages?: unknown }).splitFinderReadPages = readPages;
  const worker = createWorker({
    store: new IdbScanStore(),
    cache: new IdbCache(),
    prefs,
    ledger: appendLedger,
    fetchFn: (input, init) => fetch(input, init),
    now: Date.now,
    // Set only in the end-to-end build; undefined means https://serpapi.com.
    baseUrl: __SPLIT_FINDER_BASE_URL__,
    readPages,
    pages: chromePages(),
    notify,
    broadcast: (state) => {
      // No page may be open to receive it.
      browser.runtime.sendMessage({ type: 'stateChanged', state } satisfies StateChanged).catch(() => {});
    },
  });

  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // This extension's own pages may ask the worker anything; its content script, only the chip's messages.
    if (!mayAsk(sender, browser.runtime.id, (request as { type?: unknown } | null)?.type, CONTENT_REQUESTS)) {
      sendResponse({ ok: false, error: 'This request is not allowed from here.' });
      return false;
    }
    worker.onMessage(request as Request, { tabId: sender.tab?.id }).then(sendResponse);
    return true;
  });

  // The owner turned the chip on or off (the settings page writes storage.local): tabs showing a page are told.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.showChip) void worker.onChipSetting(changes.showChip.newValue !== false);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void worker.onTabClosed(tabId);
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TICK) void worker.onTick();
  });

  void browser.alarms
    .get(TICK)
    .then((alarm) => {
      if (!alarm) return browser.alarms.create(TICK, { periodInMinutes: 1 });
    })
    .catch(() => {});

  if (typeof browser.sidePanel?.setPanelBehavior === 'function') {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }

  void worker.onStart();
});
