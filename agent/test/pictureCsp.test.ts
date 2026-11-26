// The app's content security policy lets pictures load from exactly the hosts core/src/links/pictures.ts shows, named
// one by one: the agent's header for /ui/ and the shell's own config.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PICTURE_HOSTS } from '../../core/src/links/pictures';
import { UI_CSP } from '../uiStatic';

describe('the content security policy', () => {
  const imgSrc = (csp: string): string[] =>
    (/(?:^|;)\s*img-src ([^;]+)/.exec(csp)?.[1] ?? '').trim().split(/\s+/);
  const expected = ["'self'", 'data:', ...PICTURE_HOSTS.map((h) => `https://${h}`)];

  it('of the agent’s /ui/ names exactly the picture hosts, one by one', () => {
    expect(imgSrc(UI_CSP)).toEqual(expected);
  });

  it('of the app’s own pages names the same', () => {
    const conf = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../src-tauri/tauri.conf.json'), 'utf8')) as {
      app: { security: { csp: string } };
    };
    expect(imgSrc(conf.app.security.csp)).toEqual(expected);
  });
});
