// @vitest-environment jsdom
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureFonts, FONT_STYLE_ID, fontFaceCss } from './fonts';

const urlOf = (path: string) => `chrome-extension://abc${path}`;

afterEach(() => {
  document.head.innerHTML = '';
});

describe('fontFaceCss', () => {
  it('declares the design\'s two faces in the weights the chip uses, from the extension\'s own files, under extension-only names', () => {
    const css = fontFaceCss(urlOf);
    expect(css.match(/@font-face/g)).toHaveLength(6);
    for (const w of [400, 500, 600]) {
      expect(css).toContain(`font-family:'Split Finder Barlow';font-style:normal;font-weight:${w}`);
      expect(css).toContain(`font-family:'Split Finder JetBrains Mono';font-style:normal;font-weight:${w}`);
    }
    // Never the page's own family names: a page with its own "Barlow" must not change.
    expect(css).not.toMatch(/font-family:'(Barlow|JetBrains Mono)'/);
  });

  it('points only at files that exist in public/fonts, the ones the panel uses', () => {
    const files = [...fontFaceCss(urlOf).matchAll(/chrome-extension:\/\/abc\/(fonts\/[a-z0-9-]+\.woff2)/g)].map((m) => m[1]!);
    expect(files).toHaveLength(6);
    for (const f of files) expect(existsSync(resolve('public', f)), f).toBe(true);
  });
});

describe('ensureFonts', () => {
  it('puts the rules in the page\'s own document, once', () => {
    ensureFonts(document, urlOf);
    ensureFonts(document, urlOf);
    const styles = document.head.querySelectorAll(`#${FONT_STYLE_ID}`);
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toBe(fontFaceCss(urlOf));
  });
});
