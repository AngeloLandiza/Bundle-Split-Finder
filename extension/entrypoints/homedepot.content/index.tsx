// The chip under the price on a Home Depot product page. The page's own embedded state is read, the worker
// says what the bundle is worth (no search), and the chip shows it in a shadow root. Wiring only: the logic
// is in controller.ts, the words in chipModel.ts, the mounting in mountChip.tsx.

import { browser } from 'wxt/browser';
import './chip.css';
import { createChipController, type ChipEnv } from './controller';
import { chipSettingOf } from './protocol';
import { prepareChip } from './mountChip';
import { itemIdOf, stateTextOf } from './pageRead';

// Set only in the end-to-end build: the replay server stands in for Home Depot (a match pattern has no port).
declare const __SPLIT_FINDER_BASE_URL__: string | undefined;

export default defineContentScript({
  matches: __SPLIT_FINDER_BASE_URL__ === undefined ? ['https://www.homedepot.com/p/*'] : ['https://www.homedepot.com/p/*', 'http://localhost/p/*'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    const env: ChipEnv = {
      itemId: () => itemIdOf(location.pathname),
      stateText: () => stateTextOf(document),
      send: (message) => browser.runtime.sendMessage(message),
      prepare: (model, open) => prepareChip(ctx, model, open),
    };
    const chip = createChipController(env);

    // A full load runs this script once. Moving to another product without one fires wxt:locationchange.
    ctx.addEventListener(window, 'wxt:locationchange', () => void chip.navigated());
    // The setting is the worker's: it answers pageSeen with `off` while the chip is off, and tells this tab when
    // the owner changes it. Only this extension's own messages count.
    const onMessage = (message: unknown, sender: { id?: string }) => {
      const show = chipSettingOf(message);
      if (show !== null && sender.id === browser.runtime.id) void chip.setShown(show);
    };
    browser.runtime.onMessage.addListener(onMessage);
    ctx.onInvalidated(() => {
      browser.runtime.onMessage.removeListener(onMessage);
      chip.stop();
    });

    await chip.refresh();
  },
});
