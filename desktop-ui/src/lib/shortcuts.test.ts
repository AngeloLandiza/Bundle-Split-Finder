import { describe, expect, it } from 'vitest';
import { globalKey, SCREENS, windowsKey } from './keys';
import { shortcutAreas } from './shortcuts';

describe('the shortcuts sheet', () => {
  it('lists every area, each with something in it', () => {
    const areas = shortcutAreas(true);
    expect(areas.map((a) => a.title)).toEqual(['Anywhere', 'Command palette', 'Deals and Review lists', 'Review', 'Menus and sheets']);
    expect(areas.every((a) => a.items.length > 0)).toBe(true);
  });

  it('has a row for every global key keys.ts answers to', () => {
    const anywhere = shortcutAreas(true)[0]!.items.flatMap((i) => [i.keys.join(''), ...(i.or ? [i.or.join('')] : [])]);
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

  it('lists every key windowsKey handles, and Scan now and Settings on both systems', () => {
    // Each key the page takes itself on Windows is on the Windows sheet; the Mac sheet has Scan now and Settings too (the menu takes them).
    const win = shortcutAreas(false, true)[0]!.items.flatMap((i) => [i.keys.join('+'), ...(i.or ? [i.or.join('+')] : [])]);
    expect(windowsKey({ key: 'r', ctrl: true })).toEqual({ type: 'scan' });
    expect(win).toContain('Ctrl+R');
    expect(windowsKey({ key: ',', ctrl: true })).toEqual({ type: 'settings' });
    expect(win).toContain('Ctrl+,');
    expect(windowsKey({ key: 'F5' })).toEqual({ type: 'refresh' });
    expect(win).toContain('F5');
    const mac = shortcutAreas(true, false)[0]!.items.flatMap((i) => [i.keys.join(''), ...(i.or ? [i.or.join('')] : [])]);
    expect(mac).toContain('⌘R');
    expect(mac).toContain('⌘,');
    expect(mac).not.toContain('F5');
  });
});
