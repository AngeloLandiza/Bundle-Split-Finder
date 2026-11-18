// The chip in a shadow root, directly after the price block, mounted when the price block is on the page.
// The page's styles cannot reach it and its styles cannot leak out (design.md). No price block, no chip.

import { createRoot, type Root } from 'react-dom/client';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { Chip } from './Chip';
import type { ChipModel } from './chipModel';
import type { PreparedChip } from './controller';

/** The price block of a product page (checked Nov 17: data-component="price:Price:v6.41.0"). */
export const ANCHOR = '[data-component^="price:Price"]';

/** The shadow host's tag name (WXT: kebab-case). */
export const HOST_NAME = 'split-finder-chip';

export async function prepareChip(ctx: ContentScriptContext, model: ChipModel, open: () => Promise<boolean>): Promise<PreparedChip> {
  const ui = await createShadowRootUi<Root>(ctx, {
    name: HOST_NAME,
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
  return { start: () => ui.autoMount(), remove: () => ui.remove() };
}
