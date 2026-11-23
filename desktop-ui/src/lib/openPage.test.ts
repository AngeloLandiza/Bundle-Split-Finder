// @vitest-environment jsdom
// Nov 23: links did nothing inside the app window (window.open is ignored there). Every web link now goes to the shell.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPage, routeLinkClicks } from './actions';

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('opening a web link', () => {
  it('asks the shell inside the app, and never for anything but a web address', () => {
    const invoke = vi.fn(async () => undefined);
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
    expect(openPage('https://www.amazon.com/dp/B0C3YBY7CD')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://www.amazon.com/dp/B0C3YBY7CD' });
    expect(openPage('javascript:alert(1)')).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('uses a new browser tab outside the app', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openPage('https://www.homedepot.com/p/317987591')).toBe(true);
    expect(open).toHaveBeenCalled();
  });

  it('takes a click on any web link in the page', () => {
    const invoke = vi.fn(async () => undefined);
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
    const stop = routeLinkClicks();
    document.body.innerHTML = '<a id="a" href="https://www.amazon.com/s?k=RYOBI+PCL702B" target="_blank"><span id="s">Amazon</span></a><a id="h" href="#/deals">in app</a>';
    document.getElementById('s')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'https://www.amazon.com/s?k=RYOBI+PCL702B' });
    document.getElementById('h')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(invoke).toHaveBeenCalledTimes(1);
    stop();
  });
});
