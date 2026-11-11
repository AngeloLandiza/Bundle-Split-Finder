// @vitest-environment jsdom
// Focus after Detail closes (QA m6), on the real Deals tab and the real Detail screen.
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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
  estimate: { cost: 800, netRevenue: 1137.3, profit: 337.3, roi: 0.4216 }, uncovered: [],
});

const REPORT: PanelReport = { bundles: [row('first'), row('second')], review: [], packaging: {} };
const STATE: AppState = {
  hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS, scanRunning: false,
  lastJob: { id: '1', startedAt: 1, finishedAt: NOW - 60_000, status: 'done', stopReason: null, stopMessage: null, phase: 'finish', queue: [], deferred: [], searchesUsed: 2, counts: {} } as unknown as ScanJob,
  nextRunAt: null,
};

function setup() {
  const send = vi.fn(async (r: Request): Promise<Reply> => {
    if (r.type === 'getState') return { ok: true, data: STATE };
    if (r.type === 'getReport') return { ok: true, data: REPORT };
    if (r.type === 'quote') return { ok: true, data: { searches: 1, refusal: null } };
    return { ok: true, data: null };
  });
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
  render(createElement(App, { api, openSettings: vi.fn(), now: () => NOW }));
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
});
