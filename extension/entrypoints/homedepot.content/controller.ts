// The chip's behaviour with the browser taken out: read the page, tell the worker, show what it says, and
// follow the page when it changes. index.tsx wires the real document, storage, messages and shadow root;
// the tests wire fakes.

import { parseProductPage } from '@core/hdPage';
import { type ChipModel, chipModel } from './chipModel';
import { type ChipRequest, didOpen, isBundleView } from './protocol';

/** A chip that is built but not on the page yet. */
export interface PreparedChip {
  /** Mounts the chip under the price once the price is on the page; does nothing if there is no price. */
  start(): void;
  /** Takes the chip off the page and stops waiting for the price. */
  remove(): void;
}

export interface ChipEnv {
  /** The item id of the page now open (its address), or null when it is not a product page. */
  itemId(): string | null;
  /** The text of the page's inline script holding its state; null when the document has none. */
  stateText(): string | null;
  /** The owner's "Show the chip" setting. */
  showChip(): Promise<boolean>;
  /** One message to the worker; resolves with its reply. */
  send(message: ChipRequest): Promise<unknown>;
  /** Builds the chip. `open` is what a click does; it says whether the side panel opened. */
  prepare(model: ChipModel, open: () => Promise<boolean>): Promise<PreparedChip>;
}

export interface ChipController {
  /** Read the page again and show what the worker says. */
  refresh(): Promise<void>;
  /** The address changed: follow it. The same product again (a hash or a query change) is left alone. */
  navigated(): Promise<void>;
  /** The content script is gone: take the chip off. */
  stop(): void;
}

export function createChipController(env: ChipEnv): ChipController {
  // Each refresh takes a number; an answer that arrives after a newer refresh began belongs to a page
  // that is no longer open and is dropped, so a slow reply never puts the old product's chip back.
  let latest = 0;
  let chip: PreparedChip | null = null;
  let handled: string | null = null;

  const clear = () => {
    chip?.remove();
    chip = null;
  };

  async function refresh(): Promise<void> {
    const mine = ++latest;
    clear();
    const itemId = env.itemId();
    handled = itemId;
    if (itemId === null) return;
    try {
      if (!(await env.showChip()) || mine !== latest) return;
      const text = env.stateText();
      // The page's state names its own product only; one left over from another product parses to null.
      const page = text === null ? null : parseProductPage(text, itemId);
      if (page === null) return;
      const reply = await env.send({ type: 'pageSeen', page });
      if (mine !== latest || !isBundleView(reply)) return;
      const model = chipModel(reply);
      if (model === null) return;
      const prepared = await env.prepare(model, async () => didOpen(await env.send({ type: 'openThisPage' })));
      if (mine !== latest) {
        prepared.remove();
        return;
      }
      chip = prepared;
      prepared.start();
    } catch {
      // The worker is not there (the extension was reloaded) or the page changed under us: no chip.
    }
  }

  return {
    refresh,
    async navigated() {
      if (env.itemId() === handled) return;
      await refresh();
    },
    stop() {
      latest++;
      clear();
    },
  };
}
