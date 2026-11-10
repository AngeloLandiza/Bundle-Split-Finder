import { describe, expect, it } from 'vitest';

import { isOwnPage } from './sender';

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
