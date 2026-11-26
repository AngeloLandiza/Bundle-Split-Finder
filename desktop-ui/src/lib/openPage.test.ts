// @vitest-environment jsdom
// Nov 23: links did nothing inside the app window (window.open is ignored there). Every web link now goes to the shell.
// Nov 25: a listed source page goes to the app's page viewer, with the deal it belongs to; anything else, a Cmd-click
// (Ctrl-click on Windows) and "In my browser" go to the default browser.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPage, pageAction, routeLinkClicks } from './actions';
import { setLinkContext } from './linkContext';
import { saveLinkPrefs } from './linkPrefs';
import { isMac } from './platform';

const shell = () => {
  const invoke = vi.fn(async () => undefined);
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
  return invoke;
};

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
  setLinkContext('deal:hd-1', null);
});

const AMAZON = 'https://www.amazon.com/dp/B0C3YBY7CD';
const CONTEXT = { title: 'Kit', pages: [{ label: 'Home Depot · PCL1200K2', url: 'https://www.homedepot.com/p/322138483' }, { label: 'Amazon · PCL205B', url: AMAZON }] };

describe('opening a web link', () => {
  it('opens a source page in the viewer inside the app, with its deal, and never anything but a web address', () => {
    const invoke = shell();
    expect(openPage(AMAZON, { context: CONTEXT })).toBe(true);
    expect(invoke).toHaveBeenCalledWith('viewer_open', { url: AMAZON, context: CONTEXT });
    expect(openPage('javascript:alert(1)')).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('sends any other page to the browser: Seller Central, a sign-up page, a download', () => {
    const invoke = shell();
    openPage('https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=B09HDZ5MPV');
    openPage('https://serpapi.com/users/sign_up');
    expect(invoke.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['open_external', 'open_external']);
  });

  it('sends a source page to the browser when asked, and when Settings say "In my browser"', () => {
    const invoke = shell();
    openPage(AMAZON, { browser: true });
    expect(invoke).toHaveBeenLastCalledWith('open_external', { url: AMAZON });
    saveLinkPrefs({ openLinksIn: 'browser', showPictures: true });
    openPage(AMAZON);
    expect(invoke).toHaveBeenLastCalledWith('open_external', { url: AMAZON });
  });

  it('falls back to the browser when the shell refuses the viewer', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'viewer_open') throw new Error('refused');
    });
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
    openPage(AMAZON);
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('open_external', { url: AMAZON }));
  });

  it('uses a new browser tab outside the app (the browser dev mode)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openPage('https://www.homedepot.com/p/317987591')).toBe(true);
    expect(open).toHaveBeenCalled();
  });

  it('copies the address a menu item names', async () => {
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    expect(await pageAction('copy', AMAZON)).toBe(true);
    expect(write).toHaveBeenCalledWith(AMAZON);
    expect(await pageAction('copy', 'file:///etc/passwd')).toBe(false);
  });
});

describe('a click on a link in the page', () => {
  it('opens the viewer with the deal of the part of the page it is in', () => {
    const invoke = shell();
    const stop = routeLinkClicks();
    setLinkContext('deal:hd-1', CONTEXT);
    document.body.innerHTML = `<div data-link-context="deal:hd-1"><a id="a" href="${AMAZON}" target="_blank"><span id="s">B0C3YBY7CD</span></a></div><a id="h" href="#/deals">in app</a>`;
    document.getElementById('s')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(invoke).toHaveBeenCalledWith('viewer_open', { url: AMAZON, context: CONTEXT });
    document.getElementById('h')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(invoke).toHaveBeenCalledTimes(1);
    stop();
  });

  it('goes to the browser on Cmd-click (Ctrl-click on Windows), even when a row stops the click', () => {
    const invoke = shell();
    const stop = routeLinkClicks();
    document.body.innerHTML = `<div id="row"><a id="a" href="${AMAZON}">x</a></div>`;
    document.getElementById('row')!.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: isMac, ctrlKey: !isMac }));
    expect(invoke).toHaveBeenCalledWith('open_external', { url: AMAZON });
    stop();
  });
});
