// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { HOST_NAME, prepareChip } from './mountChip';

// The real WXT shadow-root UI in jsdom, with a stand-in for the content script's context (no CSS to fetch).
const ctx = { options: {}, onInvalidated: () => () => {} } as unknown as ContentScriptContext;
const PRICE = '<div id="price" data-component="price:Price:v6.41.0">$189.00</div>';
const model = { kind: 'plain', parts: 2 } as const;

// Each chip watches the page for its price block until it is removed, so every test removes its own.
const made: { remove(): void }[] = [];
afterEach(() => {
  for (const chip of made.splice(0)) chip.remove();
  document.body.innerHTML = '';
});
const build = async () => {
  const chip = await prepareChip(ctx, model, async () => true);
  made.push(chip);
  return chip;
};

const host = () => document.querySelector(HOST_NAME);
const settle = () => new Promise((ok) => setTimeout(ok, 30));

describe('the chip on the page', () => {
  it('sits directly after the price block, in a shadow root, as one button', async () => {
    document.body.innerHTML = `<main>${PRICE}<p id="after">Add to cart</p></main>`;
    const chip = await build();
    chip.start();
    await settle();
    expect(document.getElementById('price')!.nextElementSibling).toBe(host());
    expect(host()!.nextElementSibling).toBe(document.getElementById('after'));
    // The page's own queries and styles do not see inside it.
    expect(document.querySelector('button')).toBeNull();
    const buttons = host()!.shadowRoot!.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('Splits into 2 parts');
  });

  it('does not inject when the price block is not there, and mounts when it appears', async () => {
    document.body.innerHTML = '<main><p>No price here</p></main>';
    const chip = await build();
    chip.start();
    await settle();
    expect(host()).toBeNull();
    document.querySelector('main')!.insertAdjacentHTML('afterbegin', PRICE);
    await vi.waitFor(() => expect(host()).not.toBeNull());
    chip.remove();
  });

  it('remove takes it off the page and stops waiting for the price block', async () => {
    document.body.innerHTML = `<main>${PRICE}</main>`;
    const chip = await build();
    chip.start();
    await settle();
    expect(host()).not.toBeNull();
    chip.remove();
    expect(host()).toBeNull();
    document.querySelector('main')!.insertAdjacentHTML('beforeend', PRICE);
    await settle();
    expect(host()).toBeNull();
  });

  it('a chip that is built and never started leaves the page alone', async () => {
    document.body.innerHTML = `<main>${PRICE}</main>`;
    const chip = await build();
    await settle();
    expect(host()).toBeNull();
    chip.remove();
  });
});
