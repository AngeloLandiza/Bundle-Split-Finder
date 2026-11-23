// Wiring only: the real storage, network and Chrome APIs handed to the worker in lib/worker.ts.
// Listeners are registered synchronously in main, as an MV3 service worker requires.

import { browser } from 'wxt/browser';
import type { BundleRow } from '@core/scan/types';
import { IdbCache } from '../lib/idbCache';
import { IdbScanStore } from '../lib/idbStore';
import { IdbSuggestionStore } from '../lib/idbSuggestions';
import { appendLedger } from '../lib/ledger';
import { CONTENT_REQUESTS, type ChipSetting, type Request, type ShowThisPage, type StateChanged } from '../lib/messages';
import * as prefs from '../lib/prefs';
import { mayAsk } from '../lib/sender';
import { createPageReader, createPartPriceReader, openDoorway, waitForDoorway, type ReaderEnv } from '../lib/hdReader';
import { createResearchTools } from '../lib/researchTools';
import { appHomeUrl, applyToolbarPanelBehavior } from '../lib/appPrimaryUi';
import { APP_SYNC_ALARM } from '../lib/appSync';
import { runAppSync } from '../lib/appSyncRun';
import { createWorker, type DeferredPage, type PageEnv } from '../lib/worker';
import type { ProductPage } from '../../core/src/hdPage';

declare const __SPLIT_FINDER_BASE_URL__: string | undefined;
declare const __SPLIT_FINDER_HD_ORIGIN__: string;
declare const __SPLIT_FINDER_DEBUG__: boolean;
declare const __SPLIT_FINDER_HELPER__: boolean;

const DOORWAY_KEY = 'hdReaderTab';

/** The reader's Chrome calls. Opening a background tab needs no permission. */
function chromeReaderEnv(): ReaderEnv {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return {
    origin: __SPLIT_FINDER_HD_ORIGIN__,
    openTab(url) {
      // Opened blank and remembered before it goes to the page, so the chip's content script (which runs on that page)
      // finds the tab already named as the reader's when it sends its first pageSeen. waitForDoorway never takes the
      // blank start page for the loaded one (doorwayLoaded). openDoorway waits for the blank page before it navigates.
      return openDoorway(
        {
          create: (blank) => browser.tabs.create({ url: blank, active: false }),
          get: (tabId) => browser.tabs.get(tabId),
          update: (tabId, to) => browser.tabs.update(tabId, { url: to }),
        },
        url,
        (tabId) => browser.storage.session.set({ [DOORWAY_KEY]: tabId }),
        sleep,
      );
    },
    async closeTab(tabId) {
      await browser.tabs.remove(tabId);
    },
    waitForLoad(tabId, timeoutMs) {
      return waitForDoorway((id) => browser.tabs.get(id), tabId, __SPLIT_FINDER_HD_ORIGIN__, timeoutMs, sleep);
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
    sleep,
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
const deferredKey = (tabId: number, itemId: string) => `deferred:${tabId}:${itemId}`;

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
    async setDeferred(tabId, itemId, entry) {
      if (entry === null) await browser.storage.session.remove(deferredKey(tabId, itemId));
      else await browser.storage.session.set({ [deferredKey(tabId, itemId)]: entry });
    },
    async deferredAll() {
      const all = await browser.storage.session.get(null);
      return Object.entries(all)
        .filter(([k, v]) => /^deferred:\d+:/.test(k) && typeof v === 'object' && v !== null)
        .map(([k, v]) => ({ tabId: Number(k.split(':')[1]), ...(v as DeferredPage) }))
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

async function notifyText(message: string): Promise<void> {
  await browser.notifications.create({
    type: 'basic',
    iconUrl: ICON,
    title: 'Split Finder',
    message,
  });
}

export default defineBackground(() => {
  let appPrimaryUi = false;
  const readPages = createPageReader(chromeReaderEnv(), {
    // The end-to-end build reads from the local replay server, which needs no settling.
    settleMs: __SPLIT_FINDER_BASE_URL__ === undefined ? undefined : 50,
  });
  // Home Depot's standalone price of a part (step 9): the scan's `readPartPrices`. It reads in the same doorway tab,
  // one call at a time with the page reader, and settles for the same reason.
  const readPartPrices = createPartPriceReader(chromeReaderEnv(), {
    settleMs: __SPLIT_FINDER_BASE_URL__ === undefined ? undefined : 50,
  });
  if (__SPLIT_FINDER_DEBUG__) (globalThis as { splitFinderReadPages?: unknown }).splitFinderReadPages = readPages;
  // The end-to-end build (the only one with a base URL) and a debug build expose the part price reader to the tests
  // and the console check; the production build has neither, and a test confirms its bundle does not hold the name.
  if (__SPLIT_FINDER_DEBUG__ || __SPLIT_FINDER_BASE_URL__ !== undefined) {
    (globalThis as { splitFinderReadPartPrices?: unknown }).splitFinderReadPartPrices = readPartPrices;
  }
  const store = new IdbScanStore();
  // Step 12: the research agent's free tools. Home Depot's pages and search are read in the same doorway tab, one at a time; the worker
  // never researches while a scan runs (its gate), so the two never share the tab.
  const researchTools = createResearchTools({
    env: chromeReaderEnv(),
    store,
    settleMs: __SPLIT_FINDER_BASE_URL__ === undefined ? undefined : 50,
    pauseMs: __SPLIT_FINDER_BASE_URL__ === undefined ? undefined : 0,
  });
  const worker = createWorker({
    store,
    researchTools,
    // Step 11: Ask AI's suggestions, in a store of their own.
    suggestions: new IdbSuggestionStore(),
    cache: new IdbCache(),
    prefs,
    ledger: appendLedger,
    fetchFn: (input, init) => fetch(input, init),
    now: Date.now,
    // Set only in the end-to-end build; undefined means https://serpapi.com.
    baseUrl: __SPLIT_FINDER_BASE_URL__,
    // Step 10, the same switch: eBay's API and the listing judge's model are the replay server in the end-to-end build. The
    // judge's address is fixed in core (no setting can send the key elsewhere), so the build moves its host here; the
    // production build keeps neither, and a test confirms its bundle holds no localhost address.
    ebayBaseUrl: __SPLIT_FINDER_BASE_URL__,
    judgeFetchFn:
      __SPLIT_FINDER_BASE_URL__ === undefined
        ? undefined
        : (input, init) => fetch(String(input).replace('https://api.anthropic.com', __SPLIT_FINDER_BASE_URL__), init),
    readPages,
    readPartPrices,
    pages: chromePages(),
    notify,
    notifyText,
    relayPost: async (url, body, signature) => {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Relay-Signature': signature },
        body,
      });
    },
    agentBridgePost: async (url, body) => {
      await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    },
    requestHostPermission: async (originPattern) => {
      const granted = await browser.permissions.contains({ origins: [originPattern] });
      if (granted) return true;
      return browser.permissions.request({ origins: [originPattern] });
    },
    appPrimaryUi: () => appPrimaryUi,
    openAppHome: () => {
      if (!appPrimaryUi) return Promise.resolve(false);
      return browser.tabs.create({ url: appHomeUrl(), active: true }).then(() => true, () => false);
    },
    broadcast: (state) => {
      // No page may be open to receive it.
      browser.runtime.sendMessage({ type: 'stateChanged', state } satisfies StateChanged).catch(() => {});
    },
  });

  browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (
      __SPLIT_FINDER_BASE_URL__ !== undefined
      && typeof request === 'object'
      && request !== null
      && (request as { type?: string }).type === 'runAppSync'
    ) {
      void runAppSync(worker, {
        readPages,
        onPrimaryUi: (primary, compactPanel) => {
          appPrimaryUi = primary;
          void applyToolbarPanelBehavior(primary, compactPanel);
        },
      }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false, error: 'App sync failed.' }));
      return true;
    }
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
    if (alarm.name === APP_SYNC_ALARM) {
      void runAppSync(worker, {
        readPages,
        onPrimaryUi: (primary, compactPanel) => {
          appPrimaryUi = primary;
          void applyToolbarPanelBehavior(primary, compactPanel);
        },
      });
    }
  });

  void browser.alarms
    .get(TICK)
    .then((alarm) => {
      if (!alarm) return browser.alarms.create(TICK, { periodInMinutes: 1 });
    })
    .catch(() => {});

  void browser.alarms
    .get(APP_SYNC_ALARM)
    .then((alarm) => {
      if (!alarm) return browser.alarms.create(APP_SYNC_ALARM, { periodInMinutes: 1 });
    })
    .catch(() => {});

  void prefs
    .getAppPrimaryUi()
    .then(async (primary) => {
      const compact = await prefs.getCompactHelperPanel();
      appPrimaryUi = primary;
      await applyToolbarPanelBehavior(primary, compact);
    })
  .catch(() => {});

  void worker.onStart();

  if (typeof __SPLIT_FINDER_HELPER__ !== 'undefined' && __SPLIT_FINDER_HELPER__) {
    void runAppSync(worker, { readPages, onPrimaryUi: (primary, compactPanel) => { appPrimaryUi = primary; void applyToolbarPanelBehavior(primary, compactPanel); } });
  }
});
