import { describe, expect, it } from 'vitest';
import { globalKey, listKey, reviewKey, type KeyPress } from './keys';

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
  it('leaves arrows to the radio group', () => {
    expect(reviewKey(k('ArrowDown', { target: 'choice' }))).toBeNull();
  });
});
