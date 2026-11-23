import { describe, expect, it } from 'vitest';
import { globalKey, isMenuKey, listKey, reviewKey, type KeyPress, windowsKey } from './keys';

const k = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({ key, target: 'none', ...extra });

describe('global keys', () => {
  it('moves between screens with Cmd or Ctrl and 1-5', () => {
    expect(globalKey(k('1', { meta: true }))).toEqual({ type: 'go', screen: 'today' });
    expect(globalKey(k('3', { ctrl: true, target: 'text' }))).toEqual({ type: 'go', screen: 'review' });
    expect(globalKey(k('5', { meta: true }))).toEqual({ type: 'go', screen: 'settings' });
    expect(globalKey(k('6', { meta: true }))).toBeNull();
    expect(globalKey(k('1'))).toBeNull();
  });
  it('focuses the screen filter with Cmd or Ctrl and F', () => {
    expect(globalKey(k('f', { meta: true, target: 'text' }))).toEqual({ type: 'find' });
    expect(globalKey(k('f'))).toBeNull();
  });
  it('toggles the inspector with Cmd+Option+I, read by the physical key since Option types a dead key', () => {
    expect(globalKey(k('ˆ', { code: 'KeyI', meta: true, alt: true }))).toEqual({ type: 'inspector' });
    expect(globalKey(k('i', { code: 'KeyI', ctrl: true, alt: true, target: 'text' }))).toEqual({ type: 'inspector' });
    expect(globalKey(k('i', { code: 'KeyI', meta: true }))).toBeNull();
  });
});

describe('the palette and shortcut keys', () => {
  it('opens the palette with Cmd or Ctrl and K, from a field too', () => {
    expect(globalKey(k('k', { meta: true }))).toEqual({ type: 'palette' });
    expect(globalKey(k('K', { ctrl: true, target: 'text' }))).toEqual({ type: 'palette' });
    expect(globalKey(k('k'))).toBeNull();
    expect(globalKey(k('k', { meta: true, shift: true }))).toBeNull();
  });
  it('opens the shortcuts sheet with Cmd or Ctrl and the slash', () => {
    expect(globalKey(k('/', { meta: true }))).toEqual({ type: 'shortcuts' });
    expect(globalKey(k('/'))).toBeNull();
  });
  it('opens a context menu from the keyboard with the menu key or Shift+F10', () => {
    expect(isMenuKey(k('ContextMenu'))).toBe(true);
    expect(isMenuKey(k('F10', { shift: true }))).toBe(true);
    expect(isMenuKey(k('F10'))).toBe(false);
    expect(isMenuKey(k('F10', { shift: true, meta: true }))).toBe(false);
  });
});

describe('list keys', () => {
  it('moves with J/K and the arrows, opens with Enter, closes with Escape', () => {
    expect(listKey(k('j'))).toEqual({ type: 'next' });
    expect(listKey(k('ArrowUp'))).toEqual({ type: 'prev' });
    expect(listKey(k('Enter'))).toEqual({ type: 'open' });
    expect(listKey(k('Escape', { target: 'text' }))).toEqual({ type: 'close' });
  });
  it('never acts while the owner types, and leaves Enter to a focused button', () => {
    expect(listKey(k('j', { target: 'text' }))).toBeNull();
    expect(listKey(k('Enter', { target: 'control' }))).toBeNull();
    expect(listKey(k('j', { meta: true }))).toBeNull();
  });
});

describe('review keys', () => {
  it('chooses with 1-9, saves with Enter on a choice, asks with A', () => {
    expect(reviewKey(k('1'))).toEqual({ type: 'choose', index: 0 });
    expect(reviewKey(k('9', { target: 'choice' }))).toEqual({ type: 'choose', index: 8 });
    expect(reviewKey(k('Enter', { target: 'choice' }))).toEqual({ type: 'save' });
    expect(reviewKey(k('a'))).toEqual({ type: 'ask' });
    expect(reviewKey(k('K'))).toEqual({ type: 'prev' });
  });
  it('does not take digits or letters typed into the parts field', () => {
    expect(reviewKey(k('2', { target: 'text' }))).toBeNull();
    expect(reviewKey(k('a', { target: 'text' }))).toBeNull();
    expect(reviewKey(k('0'))).toBeNull();
  });
  it('takes back the last answer with Cmd or Ctrl+Z, but not inside a text field', () => {
    expect(reviewKey(k('z', { meta: true }))).toEqual({ type: 'undo' });
    expect(reviewKey(k('z', { ctrl: true, target: 'choice' }))).toEqual({ type: 'undo' });
    expect(reviewKey(k('z', { meta: true, target: 'text' }))).toBeNull();
    expect(reviewKey(k('z', { meta: true, shift: true }))).toBeNull();
    expect(reviewKey(k('z'))).toBeNull();
  });
  it('leaves arrows to the radio group', () => {
    expect(reviewKey(k('ArrowDown', { target: 'choice' }))).toBeNull();
  });
});

describe('Ctrl on Windows answers wherever Cmd does on a Mac', () => {
  const chords: [Partial<KeyPress> & { key: string }, ReturnType<typeof globalKey>][] = [
    [{ key: '1' }, { type: 'go', screen: 'today' }],
    [{ key: '5' }, { type: 'go', screen: 'settings' }],
    [{ key: 'f' }, { type: 'find' }],
    [{ key: 'k' }, { type: 'palette' }],
    [{ key: '/' }, { type: 'shortcuts' }],
    [{ key: 'i', code: 'KeyI', alt: true }, { type: 'inspector' }],
  ];
  it('gives the same action for meta and for ctrl, in a field or out of one', () => {
    for (const [press, action] of chords) {
      for (const target of ['none', 'text'] as const) {
        expect(globalKey({ ...press, meta: true, target })).toEqual(action);
        expect(globalKey({ ...press, ctrl: true, target })).toEqual(action);
      }
    }
  });
  it('leaves a bare letter and the lists alone while Ctrl is down', () => {
    expect(listKey(k('j', { ctrl: true }))).toBeNull();
    expect(reviewKey(k('a', { ctrl: true }))).toBeNull();
    expect(listKey(k('j'))).toEqual({ type: 'next' });
  });
  it('opens a context menu with Shift+F10 or the menu key, never with Ctrl held', () => {
    expect(isMenuKey({ key: 'F10', shift: true })).toBe(true);
    expect(isMenuKey({ key: 'ContextMenu' })).toBe(true);
    expect(isMenuKey({ key: 'F10', shift: true, ctrl: true })).toBe(false);
  });
});

describe('windowsKey', () => {
  it('Ctrl+R scans, Ctrl+, opens Settings, F5 refreshes', () => {
    expect(windowsKey({ key: 'r', ctrl: true })).toEqual({ type: 'scan' });
    expect(windowsKey({ key: 'R', ctrl: true })).toEqual({ type: 'scan' });
    expect(windowsKey({ key: ',', ctrl: true })).toEqual({ type: 'settings' });
    expect(windowsKey({ key: 'F5' })).toEqual({ type: 'refresh' });
  });
  it('leaves Cmd keys to the Mac menu and other chords alone', () => {
    expect(windowsKey({ key: 'r', meta: true })).toBeNull();
    expect(windowsKey({ key: 'r', ctrl: true, shift: true })).toBeNull();
    expect(windowsKey({ key: 'r' })).toBeNull();
    expect(windowsKey({ key: 'k', ctrl: true })).toBeNull();
  });
});
