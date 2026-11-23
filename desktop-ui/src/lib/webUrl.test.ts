import { describe, expect, it } from 'vitest';

import { webUrl } from './webUrl';

// Security review, Nov 23: a link from a page, a listing or the owner is opened only when it is a web address.

describe('webUrl', () => {
  it('keeps a Home Depot, Amazon or eBay address', () => {
    expect(webUrl('https://www.homedepot.com/p/328690510')).toBe('https://www.homedepot.com/p/328690510');
    expect(webUrl('https://www.amazon.com/dp/B0CXYZ1234')).toBe('https://www.amazon.com/dp/B0CXYZ1234');
    expect(webUrl(' https://www.ebay.com/itm/1234 ')).toBe('https://www.ebay.com/itm/1234');
  });

  it('refuses a script, data, file, share or app address from a page', () => {
    for (const bad of [
      'javascript:alert(document.cookie)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///C:/Windows/System32/calc.exe',
      'file://attacker/share/x.exe',
      '\\\\attacker\\share\\x.exe',
      'ms-settings:privacy',
      'chrome://settings',
      'blob:https://www.homedepot.com/1',
      '/api/keys/serpapi',
      '',
      null,
      undefined,
    ]) {
      expect(webUrl(bad), String(bad)).toBeNull();
    }
  });

  it('refuses an address that hides its host behind a user name', () => {
    expect(webUrl('https://www.homedepot.com@evil.example/p/1')).toBeNull();
    expect(webUrl('https://user:pass@www.ebay.com/itm/1')).toBeNull();
  });
});
