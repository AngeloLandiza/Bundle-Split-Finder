import { describe, expect, it } from 'vitest';

import { isOwnContentScript, isOwnPage, mayAsk } from './sender';

describe('isOwnPage', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  it('accepts the settings page and the side panel', () => {
    expect(isOwnPage({ id, url: `chrome-extension://${id}/options.html` }, id)).toBe(true);
    expect(isOwnPage({ id, url: `chrome-extension://${id}/sidepanel.html` }, id)).toBe(true);
  });
  it('refuses a content script on a web page', () => {
    expect(isOwnPage({ id, url: 'https://www.homedepot.com/p/328814689' }, id)).toBe(false);
  });
  it('refuses another extension and a sender with no url', () => {
    expect(isOwnPage({ id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', url: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/x.html' }, id)).toBe(false);
    expect(isOwnPage({ id }, id)).toBe(false);
    expect(isOwnPage({}, id)).toBe(false);
  });
  it('refuses a page whose url only starts like the extension id', () => {
    expect(isOwnPage({ id, url: `chrome-extension://${id}x/options.html` }, id)).toBe(false);
  });
});

describe('the chip\'s content script', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  const page = { id, url: 'https://www.homedepot.com/p/328814689', tab: { id: 7 } };
  const allowed = ['pageSeen', 'openThisPage'];

  it('is this extension\'s script in a tab on a web page', () => {
    expect(isOwnContentScript(page, id)).toBe(true);
    expect(isOwnContentScript({ ...page, id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }, id)).toBe(false);
    expect(isOwnContentScript({ id, url: page.url }, id)).toBe(false);
    expect(isOwnContentScript({ ...page, url: `chrome-extension://${id}/sidepanel.html` }, id)).toBe(false);
  });

  it('may send the chip\'s two messages and nothing else', () => {
    expect(mayAsk(page, id, 'pageSeen', allowed)).toBe(true);
    expect(mayAsk(page, id, 'openThisPage', allowed)).toBe(true);
    for (const type of ['getState', 'checkKey', 'scanNow', 'runPaid', 'exportMatches', 'getThisPage', 'takeShowThisPage', undefined]) {
      expect(mayAsk(page, id, type, allowed), String(type)).toBe(false);
    }
  });

  it('is refused whatever it sends when it is another extension or has no tab', () => {
    expect(mayAsk({ ...page, id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }, id, 'pageSeen', allowed)).toBe(false);
    expect(mayAsk({ id, url: page.url }, id, 'pageSeen', allowed)).toBe(false);
  });

  it('the extension\'s own pages may ask anything', () => {
    expect(mayAsk({ id, url: `chrome-extension://${id}/sidepanel.html` }, id, 'scanNow', allowed)).toBe(true);
  });
});
