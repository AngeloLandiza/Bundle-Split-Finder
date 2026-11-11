// @vitest-environment jsdom
// Focus after Detail closes (QA m6), on the real Deals tab and the real Detail screen.
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { BundleRow, PartRow, ScanJob } from '@core/scan/types';
import type { AppState, PanelReport, Reply, Request } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { App } from './App';

afterEach(cleanup);

const NOW = new Date(2026, 10, 10, 14, 0, 0).getTime();

const part = (model: string): PartRow => ({
  model, qty: 1, status: 'matched', availability: 'active', asin: 'B0TESTASIN', grade: 'exact', price: 199, priceSeenAt: NOW - 3_600_000, image: null, title: null,
});

const row = (key: string): BundleRow => ({
  key, itemId: key, brand: 'DEWALT', model: key.toUpperCase(), title: `Title of ${key}`, link: null, price: 749, regularPrice: 1270, percentOff: 41,
  seenAt: NOW - 3_600_000, status: 'complete', section: 'confirmed', parts: [part('DCD791B'), part('DCF891B')],
  estimate: { cost: 800, netRevenue: 1137.3, profit: 337.3, roi: 0.4216 }, uncovered: [], answer: null, options: [], kitsNotRead: [],
});

const REPORT: PanelReport = { bundles: [row('first'), row('second')], review: [], packaging: {} };
const STATE: AppState = {
  hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS, scanRunning: false,
  lastJob: { id: '1', startedAt: 1, finishedAt: NOW - 60_000, status: 'done', stopReason: null, stopMessage: null, phase: 'finish', queue: [], deferred: [], searchesUsed: 2, counts: {} } as unknown as ScanJob,
  nextRunAt: null,
};

function setup(first: PanelReport = REPORT, paid?: (r: Request) => PanelReport | Reply | null, refusal: string | null = null) {
  let report = first;
  let listener: (s: AppState) => void = () => {};
  let n = 1;
  const send = vi.fn(async (r: Request): Promise<Reply> => {
    if (r.type === 'getState') return { ok: true, data: STATE };
    if (r.type === 'getReport') return { ok: true, data: report };
    if (r.type === 'quote') return { ok: true, data: { searches: 1, refusal } };
    if (r.type === 'runPaid' && paid) {
      // The worker saves, tells the panel its state changed, then replies.
      const next = paid(r);
      if (next && 'ok' in next) return next;
      if (next) {
        report = next;
        n += 1;
        listener({ ...STATE, accountCheckedAt: n });
      }
    }
    return { ok: true, data: null };
  });
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: (l) => {
      listener = l;
      return () => {};
    }, download: vi.fn() };
  render(createElement(App, { api, openSettings: vi.fn(), now: () => NOW }));
  return {
    send,
    // The row leaves the report while Detail is open: a state change makes the panel read the report again.
    drop: (key: string) => {
      report = { ...REPORT, bundles: REPORT.bundles.filter((b) => b.key !== key) };
      return act(async () => listener({ ...STATE, accountCheckedAt: 2 }));
    },
  };
}

describe('focus after Detail closes', () => {
  it('Back returns focus to the link of the row that was opened', async () => {
    const user = userEvent.setup();
    setup();
    const second = await screen.findByRole('link', { name: /Title of second/ });
    expect(second).toHaveAttribute('data-key', 'second');
    await user.click(second);
    await user.click(await screen.findByRole('button', { name: 'Deals' }));
    expect(await screen.findByRole('link', { name: /Title of second/ })).toHaveFocus();
  });

  it('Escape returns focus to the same link', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('link', { name: /Title of first/ }));
    await screen.findByRole('button', { name: 'Deals' });
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('link', { name: /Title of first/ })).toHaveFocus();
  });

  it('moves focus to the Deals tab when the opened row has left the report', async () => {
    const user = userEvent.setup();
    const { drop } = setup();
    await user.click(await screen.findByRole('link', { name: /Title of first/ }));
    await screen.findByRole('button', { name: 'Deals' });
    await drop('first');
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('link', { name: /Title of second/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Title of first/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Deals/ })).toHaveFocus();
  });
});

describe('focus after a paid action', () => {
  const waitingPart = (model: string): PartRow => ({ ...part(model), status: 'waiting', availability: 'missing', asin: null, grade: null, price: null });
  const waiting = (key: string): BundleRow => ({ ...row(key), section: 'waiting', status: 'partial', estimate: null, parts: [waitingPart('DCD791B')], uncovered: ['DCD791B'] });
  const done = (key: string): BundleRow => ({ ...row(key), section: 'confirmed' });
  const title = (key: string) => screen.findByRole('heading', { level: 1, name: `Title of ${key}` });

  it('Deals: a Look up that removes its button leaves focus on the row link', async () => {
    const user = userEvent.setup();
    setup({ bundles: [waiting('first'), row('second')], review: [], packaging: {} }, () => ({ bundles: [done('first'), row('second')], review: [], packaging: {} }));
    await user.click(await screen.findByRole('button', { name: /^Look up/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Look up/ })).toBeNull());
    expect(await screen.findByRole('link', { name: /Title of first/ })).toHaveFocus();
  });

  it('Deals: when the row has left the report too, focus goes to the Deals tab', async () => {
    const user = userEvent.setup();
    setup({ bundles: [waiting('first'), row('second')], review: [], packaging: {} }, () => ({ bundles: [row('second')], review: [], packaging: {} }));
    await user.click(await screen.findByRole('button', { name: /^Look up/ }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /Title of first/ })).toBeNull());
    expect(screen.getByRole('button', { name: /^Deals/ })).toHaveFocus();
  });

  it('Deals: a Look up that leaves its button keeps focus on it', async () => {
    const user = userEvent.setup();
    setup({ bundles: [waiting('first')], review: [], packaging: {} }, () => ({ bundles: [waiting('first')], review: [], packaging: {} }));
    const button = await screen.findByRole('button', { name: /^Look up/ });
    await user.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Look up/ })).not.toHaveAttribute('aria-disabled'));
    expect(screen.getByRole('button', { name: /^Look up/ })).toHaveFocus();
  });

  it('Deals: focus is left alone when it was not on the button', async () => {
    const user = userEvent.setup();
    setup({ bundles: [waiting('first'), row('second')], review: [], packaging: {} }, () => ({ bundles: [done('first'), row('second')], review: [], packaging: {} }));
    const button = await screen.findByRole('button', { name: /^Look up/ });
    // Pressed with the keyboard-less path: the click handler runs, but focus has moved to the other row.
    const other = screen.getByRole('link', { name: /Title of second/ });
    await user.click(button);
    other.focus();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Look up/ })).toBeNull());
    expect(other).toHaveFocus();
  });

  it('Deals: a failed Look up leaves focus on its button, never <body>', async () => {
    const user = userEvent.setup();
    setup({ bundles: [waiting('first')], review: [], packaging: {} }, () => ({ ok: false, error: 'SerpApi returned HTTP 503.' }));
    await user.click(await screen.findByRole('button', { name: /^Look up/ }));
    await screen.findByText(/SerpApi answered with an error/);
    const button = screen.getByRole('button', { name: /^Look up/ });
    expect(button).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it('Deals: a refused Look up keeps focus on its button, and sends nothing', async () => {
    const user = userEvent.setup();
    const { send } = setup({ bundles: [waiting('first')], review: [], packaging: {} }, () => null, 'The monthly allowance is used up.');
    const button = await screen.findByRole('button', { name: /^Look up/ });
    await screen.findByText('The monthly allowance is used up.');
    await user.click(button);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveFocus();
    expect(send.mock.calls.some(([r]) => r.type === 'runPaid')).toBe(false);
  });

  it('Detail: a failed Verify leaves focus on its button, never <body>', async () => {
    const user = userEvent.setup();
    const probable = { ...REPORT.bundles[0]!, key: 'first', parts: [{ ...part('DCD791B'), grade: 'probable' as const }, part('DCF891B')] };
    setup({ bundles: [probable], review: [], packaging: {} }, () => ({ ok: false, error: 'SerpApi returned HTTP 503.' }));
    await user.click(await screen.findByRole('link', { name: /Title of first/ }));
    await user.click(await screen.findByRole('button', { name: /^Verify/ }));
    await screen.findByText(/SerpApi answered with an error/);
    expect(screen.getByRole('button', { name: /^Verify/ })).toHaveFocus();
  });

  it('Detail: a Look up that removes its button leaves focus on the title', async () => {
    const user = userEvent.setup();
    setup({ bundles: [waiting('first')], review: [], packaging: {} }, () => ({ bundles: [done('first')], review: [], packaging: {} }));
    await user.click(await screen.findByRole('link', { name: /Title of first/ }));
    const heading = await title('first');
    await user.click(await screen.findByRole('button', { name: /^Look up/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Look up/ })).toBeNull());
    expect(heading).toHaveFocus();
  });

  it('Detail: a Verify that removes its button leaves focus on the title', async () => {
    const user = userEvent.setup();
    const probable = { ...REPORT.bundles[0]!, key: 'first', parts: [{ ...part('DCD791B'), grade: 'probable' as const }, part('DCF891B')] };
    const verified = { ...probable, parts: [part('DCD791B'), part('DCF891B')] };
    setup({ bundles: [probable], review: [], packaging: {} }, () => ({ bundles: [verified], review: [], packaging: {} }));
    await user.click(await screen.findByRole('link', { name: /Title of first/ }));
    const heading = await title('first');
    await user.click(await screen.findByRole('button', { name: /^Verify/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Verify/ })).toBeNull());
    expect(heading).toHaveFocus();
  });
});
