import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = (file: string): string => readFileSync(join(import.meta.dirname, file), 'utf8');

/** The z-index of the first rule for `selector` in a stylesheet. */
function layer(sheet: string, selector: string): number {
  const rule = new RegExp(`(^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(sheet);
  const z = rule ? /z-index:\s*(\d+)/.exec(rule[2]!) : null;
  if (!z) throw new Error(`no z-index for ${selector}`);
  return Number(z[1]);
}

describe('layers', () => {
  it('a toolbar popover opens over the notice banner, and sheets, the palette and menus over both', () => {
    // Nov 25, the owner's screenshot: View options opened behind the amber banner. A popover stacks inside the toolbar,
    // so the toolbar must sit above the notices under it.
    const toolbar = layer(css('Toolbar.css'), '.toolbar');
    const notices = layer(css('Page.css'), '.notices');
    expect(toolbar).toBeGreaterThan(notices);
    for (const [file, selector] of [['Sheet.css', '.sheet-backdrop'], ['CommandPalette.css', '.palette-backdrop'], ['ContextMenu.css', '.context-menu']] as const) {
      const sheet = css(file);
      const z = Number(/z-index:\s*(\d+)/.exec(sheet)?.[1]);
      expect(z, `${file} ${selector}`).toBeGreaterThan(toolbar);
    }
  });
});
