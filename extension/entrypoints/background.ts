// Wiring only: the real storage, network and Chrome APIs handed to the worker in lib/worker.ts.
// Listeners are registered synchronously in main, as an MV3 service worker requires.

import { browser } from 'wxt/browser';
import type { BundleRow } from '@core/scan/types';
import { IdbCache } from '../lib/idbCache';
import { IdbScanStore } from '../lib/idbStore';
import { appendLedger } from '../lib/ledger';
import type { Request, StateChanged } from '../lib/messages';
import * as prefs from '../lib/prefs';
import { createWorker } from '../lib/worker';

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
  const worker = createWorker({
    store: new IdbScanStore(),
    cache: new IdbCache(),
    prefs,
    ledger: appendLedger,
    fetchFn: (input, init) => fetch(input, init),
    now: Date.now,
    notify,
    broadcast: (state) => {
      // No page may be open to receive it.
      browser.runtime.sendMessage({ type: 'stateChanged', state } satisfies StateChanged).catch(() => {});
    },
  });

  browser.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    worker.onMessage(request as Request).then(sendResponse);
    return true;
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TICK) void worker.onTick();
  });

  void browser.alarms.get(TICK).then((alarm) => {
    if (!alarm) return browser.alarms.create(TICK, { periodInMinutes: 1 });
  });

  if (typeof browser.sidePanel?.setPanelBehavior === 'function') {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }

  void worker.onStart();
});
