import { describe, expect, it } from 'vitest';
import { globalKey, SCREENS } from './keys';
import { shortcutAreas } from './shortcuts';

describe('the shortcuts sheet', () => {
  it('lists every area, each with something in it', () => {
    const areas = shortcutAreas(true);
    expect(areas.map((a) => a.title)).toEqual(['Anywhere', 'Command palette', 'Deals and Review lists', 'Review', 'Menus and sheets']);
    expect(areas.every((a) => a.items.length > 0)).toBe(true);
  });

  it('has a row for every global key keys.ts answers to', () => {
    const anywhere = shortcutAreas(true)[0]!.items.map((i) => i.keys.join(''));
    expect(anywhere).toContain('⌘K');
    expect(anywhere).toContain('⌘/');
    expect(anywhere).toContain('⌘F');
    expect(anywhere).toContain('⌘⌥I');
    for (let i = 1; i <= SCREENS.length; i++) {
      expect(globalKey({ key: String(i), meta: true, target: 'none' })).toEqual({ type: 'go', screen: SCREENS[i - 1] });
      expect(anywhere).toContain(`⌘${i}`);
    }
  });

  it('says Ctrl and Alt off a Mac', () => {
    const anywhere = shortcutAreas(false)[0]!.items;
    expect(anywhere.find((i) => i.does === 'Command palette')!.keys).toEqual(['Ctrl', 'K']);
    expect(anywhere.find((i) => i.does === 'Show or hide the inspector')!.keys).toEqual(['Ctrl', 'Alt', 'I']);
  });
});
