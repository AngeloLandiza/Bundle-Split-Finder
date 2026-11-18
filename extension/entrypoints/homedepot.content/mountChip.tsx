// The chip in a shadow root, directly after the price block, mounted when the price block is on the page.
// The page's styles cannot reach it and its styles cannot leak out (design.md). No price block, no chip.

import { createRoot, type Root } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { Chip } from './Chip';
import type { ChipModel } from './chipModel';
import type { PreparedChip } from './controller';
import { ensureFonts } from './fonts';

/** The price block of a product page (checked Nov 17: data-component="price:Price:v6.41.0"). */
export const ANCHOR = '[data-component^="price:Price"]';

// Set only in the end-to-end build (the replay server's origin). Not declared in the unit tests, hence the typeof.
declare const __SPLIT_FINDER_BASE_URL__: string | undefined;

/**
 * Closed, so a script on the Home Depot page cannot read the estimate or click the button through
 * `host.shadowRoot`. The end-to-end build opens it, because Playwright cannot see inside a closed root; the
 * production build folds this to 'closed' (wxt-config.test.ts checks the built script).
 */
const MODE: 'open' | 'closed' = typeof __SPLIT_FINDER_BASE_URL__ === 'string' ? 'open' : 'closed';

/** The shadow host's tag name (WXT: kebab-case). */
export const HOST_NAME = 'split-finder-chip';

/**
 * `onShadow` hands a test the shadow root, which a closed root does not give through its host. Production passes none.
 */
export async function prepareChip(
  ctx: ContentScriptContext, model: ChipModel, open: () => Promise<boolean>, onShadow?: (shadow: ShadowRoot) => void,
): Promise<PreparedChip> {
  ensureFonts(document, (path) => browser.runtime.getURL(path as never));
  const ui = await createShadowRootUi<Root>(ctx, {
    name: HOST_NAME,
    mode: MODE,
    position: 'inline',
    anchor: ANCHOR,
    append: 'after',
    onMount(container) {
      const wrapper = document.createElement('div');
      container.append(wrapper);
      const root = createRoot(wrapper);
      root.render(<Chip model={model} open={open} />);
      return root;
    },
    onRemove(root) {
      root?.unmount();
    },
  });
  onShadow?.(ui.shadow);
  return { start: () => ui.autoMount(), remove: () => ui.remove() };
}
