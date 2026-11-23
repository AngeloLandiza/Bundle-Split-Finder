// @vitest-environment jsdom
// Screenshots of each chip variant, for the owner and the UI reviewer. Runs only with SPLIT_FINDER_SHOTS=1:
//   SPLIT_FINDER_SHOTS=1 npx vitest run --config vitest.ext.config.ts extension/entrypoints/homedepot.content/Chip.shots.test.ts
// The chip is server-rendered from the real component into a shadow root in headless Chromium (as it sits on a
// Home Depot page), under a price line, at 2x, into qa-shots/. Component level: no extension, no worker.
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Chip, COULD_NOT_OPEN } from './Chip';
import { chipModel } from './chipModel';
import { fontFaceCss } from './fonts';
import { estimateView, lookupView, noReadingView, oneReadingView } from '../../test-helpers/realViews';

const OUT = resolve('qa-shots');
const css = readFileSync(join(__dirname, 'chip.css'), 'utf8').replace(/\r\n/g, '\n').replaceAll(':root', ':host');
// The fonts as the extension serves them to the page (fonts.ts), here as data URLs so a blank page can load them.
const fonts = fontFaceCss((path) => `data:font/woff2;base64,${readFileSync(resolve('public', path.slice(1))).toString('base64')}`);

describe.skipIf(!process.env.SPLIT_FINDER_SHOTS)('chip screenshots', () => {
  it('writes one image per variant into qa-shots/', async () => {
    mkdirSync(OUT, { recursive: true });
    const estimate = (await estimateView());
    const loss = { ...estimate, row: { ...estimate.row, estimate: { ...estimate.row.estimate!, profit: -12.4, roi: -0.06 } } };
    const variants: [string, string][] = [
      ['estimate', html(chipModel(estimate)!)],
      ['loss', html(chipModel(loss)!)],
      ['lookup', html(chipModel(await lookupView())!)],
      ['needs-answer', html(chipModel(await oneReadingView())!)],
      ['needs-answer-no-reading', html(chipModel(await noReadingView())!)],
      ['could-not-open', await couldNotOpen(chipModel(estimate)!)],
    ];
    const browser = await chromium.launch({ channel: 'chromium' });
    try {
      const page = await browser.newPage({ viewport: { width: 520, height: 150 }, deviceScaleFactor: 2 });
      for (const [name, markup] of variants) {
        await page.setContent(`<style>${fonts}</style><body style="margin:0;padding:16px;background:#fff;font-family:system-ui,sans-serif"><div style="font-size:34px;line-height:40px;font-weight:700;color:#1F1F1F" data-component="price:Price:v6.41.0">$189.00</div><div id="h"></div></body>`);
        await page.evaluate(([c, m]) => {
          const shadow = document.getElementById('h')!.attachShadow({ mode: 'open' });
          shadow.innerHTML = `<style>:host{all:initial !important}${c}</style>${m}`;
        }, [css, markup] as const);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);
        await page.evaluate(() => Promise.all([400, 500, 600].map((w) => document.fonts.load(`${w} 14px 'Split Finder Barlow'`))));
        await page.waitForTimeout(300);
        // The title is weight 500 in the loaded Barlow face (its width is the 500 face's, not the 400 face's or a fallback's), and the chip is 40px tall.
        const drawn = await page.evaluate(() => {
          const host = document.getElementById('h')!;
          const title = host.shadowRoot!.querySelector('.chip-title')!;
          const width = (w: number) => {
            const probe = document.createElement('span');
            probe.style.cssText = `font:${w} 14px 'Split Finder Barlow';position:absolute;white-space:nowrap`;
            probe.textContent = title.textContent;
            document.body.append(probe);
            const x = probe.getBoundingClientRect().width;
            probe.remove();
            return x;
          };
          return {
            weight: getComputedStyle(title).fontWeight,
            as500: Math.abs(title.getBoundingClientRect().width - width(500)) < 0.5,
            differsFrom400: width(500) !== width(400),
            height: host.getBoundingClientRect().height,
          };
        });
        expect(drawn, name).toEqual({ weight: '500', as500: true, differsFrom400: true, height: 40 });
        await page.screenshot({ path: join(OUT, `chip-${name}.png`), fullPage: true });
      }
    } finally {
      await browser.close();
    }
    expect(variants).toHaveLength(6);
  }, 120_000);
});

function html(model: NonNullable<ReturnType<typeof chipModel>>): string {
  return renderToStaticMarkup(createElement(Chip, { model, open: async () => true }));
}

/** The chip after a click the worker could not honour: what the owner sees when the panel would not open. */
async function couldNotOpen(model: NonNullable<ReturnType<typeof chipModel>>): Promise<string> {
  const { container } = render(createElement(Chip, { model, open: async () => false }));
  await userEvent.click(screen.getByRole('button'));
  await screen.findByRole('button', { name: COULD_NOT_OPEN });
  const out = container.innerHTML;
  cleanup();
  return out;
}
