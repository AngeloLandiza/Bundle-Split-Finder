// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reviewSignature } from '@core/scan/answers';
import { MemoryScanStore } from '@core/scan/memoryStore';
import { buildReport } from '@core/scan/report';
import { runScan } from '@core/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ReviewItem } from '@core/scan/types';
import { parseAccount, SearchBudget } from '@core/serpapi/budget';
import { MemoryCache, SerpApiClient } from '@core/serpapi/client';
import { DEFAULT_SETTINGS } from '@core/settings';
import { replayRecorded } from '../../../scripts/replay';
import * as fx from '../../../core/test/fixtures';
import type { AppState, PanelReport, Reply, Request } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { ReviewTab } from './ReviewTab';

afterEach(cleanup);

const item = (over: Partial<ReviewItem>): ReviewItem => ({
  id: 'split:a',
  kind: 'split',
  subject: 'homedepot:1',
  brand: 'DEWALT',
  model: 'DCK240C2',
  title: 'DEWALT 20V MAX Cordless 2 Tool Combo Kit',
  reason: 'The kit lists two impact wrenches.',
  candidates: [],
  choices: [],
  openedAt: 1,
  answer: null,
  answeredAt: null,
  ...over,
});

const SPLIT = item({ choices: [['DCF891B', 'DCB205'], ['DCF921B', 'DCB205']] });
const MATCH = item({
  id: 'match:DEWALT:DCF891B',
  kind: 'match',
  subject: 'DEWALT:DCF891B',
  model: 'DCF891B',
  title: null,
  reason: 'Two listings fit equally well.',
  candidates: [
    { asin: 'B0AAAAAAA1', title: 'DEWALT DCF891B 20V MAX XR Cordless Impact Wrench with a very long title that runs on and on', price: 189.5, reviews: 10, reasons: [] },
    { asin: 'B0AAAAAAA2', title: 'DEWALT DCF891B Bare Tool', price: null, reviews: 3, reasons: [] },
  ],
  openedAt: 2,
});

const state = (over: Partial<AppState> = {}): AppState => ({
  hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS,
  scanRunning: false, lastJob: null, nextRunAt: null, ...over,
});
const reportOf = (review: ReviewItem[]) => ({ bundles: [], review, packaging: {} }) as unknown as PanelReport;

function setup(report: PanelReport | null, reply: Reply = { ok: true, data: null }, st: AppState = state()) {
  const send = vi.fn(async (_r: Request): Promise<Reply> => reply);
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
  const view = render(createElement(ReviewTab, { api, report, state: st }));
  const again = (next: PanelReport, s: AppState = st) => view.rerender(createElement(ReviewTab, { api, report: next, state: s }));
  return { send, again };
}

const save = () => screen.getByRole('button', { name: 'Save answer' });

describe('ReviewTab: a split question', () => {
  it('shows the question, the reading of each choice in order, and None of these', () => {
    setup(reportOf([SPLIT, MATCH]));
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Which parts come in this bundle?' })).toBeInTheDocument();
    expect(screen.getByText('DEWALT 20V MAX Cordless 2 Tool Combo Kit')).toBeInTheDocument();
    expect(screen.getByText('DEWALT DCK240C2')).toHaveClass('fig');
    expect(screen.getByText('The kit lists two impact wrenches.')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Which parts come in this bundle?' });
    expect(group.tagName).toBe('FIELDSET');
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')!.textContent)).toEqual(['DCF891B + DCB205', 'DCF921B + DCB205', 'None of these']);
    expect(save()).toBeDisabled();
  });

  it('with no readings offers only None of these and says why', () => {
    setup(reportOf([item({ choices: [] })]));
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.getByText('None of these')).toBeInTheDocument();
    expect(screen.getByText('No reading could be made from the model number or the page.')).toBeInTheDocument();
  });

  it('sends the chosen index with the signature of the question as shown, then moves on', async () => {
    const user = userEvent.setup();
    const { send, again } = setup(reportOf([SPLIT, MATCH]));
    await user.click(screen.getByRole('radio', { name: 'DCF921B + DCB205' }));
    expect(save()).toBeEnabled();
    await user.click(save());
    expect(send).toHaveBeenCalledWith({ type: 'answerReview', id: 'split:a', answer: { choice: 1, seen: reviewSignature(SPLIT) } });
    // The next question is shown before the report reloads, and the count keeps its place.
    expect(await screen.findByText('2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Which Amazon listing is DEWALT DCF891B?' })).toBeInTheDocument();
    expect(save()).toBeDisabled();
    // The reload drops the answered item: still on the second question, still "2 of 2".
    again(reportOf([MATCH]));
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
  });

  it('None of these sends none', async () => {
    const user = userEvent.setup();
    const { send } = setup(reportOf([SPLIT]));
    await user.click(screen.getByRole('radio', { name: 'None of these' }));
    await user.click(save());
    expect(send).toHaveBeenCalledWith({ type: 'answerReview', id: 'split:a', answer: { none: true, seen: reviewSignature(SPLIT) } });
  });

  it('asks the oldest question first', () => {
    setup(reportOf([item({ id: 'split:new', model: 'NEWER', openedAt: 9 }), item({ id: 'split:old', model: 'OLDER', openedAt: 3 })]));
    expect(screen.getByText('DEWALT OLDER')).toBeInTheDocument();
  });
});

describe('ReviewTab: a match question', () => {
  it('shows each candidate with a one-line title, a price and an ASIN link', () => {
    setup(reportOf([MATCH]));
    expect(screen.getByRole('group', { name: 'Which Amazon listing is DEWALT DCF891B?' })).toBeInTheDocument();
    const first = screen.getByText(/very long title/);
    expect(first).toHaveAttribute('title', MATCH.candidates[0]!.title);
    expect(screen.getByText('$189.50')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'B0AAAAAAA1' });
    expect(link).toHaveAttribute('href', 'https://www.amazon.com/dp/B0AAAAAAA1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('sends the candidate index', async () => {
    const user = userEvent.setup();
    const { send } = setup(reportOf([MATCH]));
    await user.click(screen.getAllByRole('radio')[1]!);
    await user.click(save());
    expect(send).toHaveBeenCalledWith({ type: 'answerReview', id: MATCH.id, answer: { choice: 1, seen: reviewSignature(MATCH) } });
  });
});

describe('ReviewTab: refusals and states', () => {
  it('shows a refused answer under the button and keeps the question', async () => {
    const user = userEvent.setup();
    setup(reportOf([SPLIT]), { ok: false, error: 'That question was already answered.' });
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('That question was already answered.');
    expect(screen.getAllByRole('radio')[0]).toBeChecked();
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });

  it('a changed question clears the selection', async () => {
    const user = userEvent.setup();
    setup(reportOf([SPLIT]), { ok: false, error: 'That question changed. Choose again.' });
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('That question changed. Choose again.');
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked();
    expect(save()).toBeDisabled();
  });

  it('a worker that cannot be reached says so', async () => {
    const user = userEvent.setup();
    const send = vi.fn(async () => {
      throw new Error('gone');
    });
    const api: WorkerApi = { send: send as unknown as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    render(createElement(ReviewTab, { api, report: reportOf([SPLIT]), state: state() }));
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(UNREACHABLE);
  });

  it('says nothing needs an answer when the list is empty', () => {
    setup(reportOf([]));
    expect(screen.getByText('Nothing needs your answer.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save answer' })).toBeNull();
  });

  it('while a scan runs, Save answer stays disabled and says when to answer', async () => {
    const user = userEvent.setup();
    const { send } = setup(reportOf([SPLIT]), undefined, state({ scanRunning: true }));
    await user.click(screen.getAllByRole('radio')[0]!);
    expect(save()).toBeDisabled();
    expect(screen.getByText('A scan is running. Answer when it has finished.')).toBeInTheDocument();
    await user.click(save());
    expect(send).not.toHaveBeenCalled();
  });
});

describe('ReviewTab: a report built on the replayed recordings', () => {
  it('asks about a ratchet bundle that no reading could be made for, and answers it', async () => {
    const T0 = Date.UTC(2026, 10, 9, 12);
    const store = new MemoryScanStore();
    const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
    const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
    const settings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };
    await runScan({ client, budget, store, settings, now: () => T0 });
    const report = (await buildReport(store, settings)) as unknown as PanelReport;
    expect(report.review.length).toBeGreaterThan(1);
    const first = [...report.review].sort((a, b) => a.openedAt - b.openedAt)[0]!;

    const user = userEvent.setup();
    const { send } = setup(report);
    expect(screen.getByText(`1 of ${report.review.length}`)).toBeInTheDocument();
    expect(screen.getByText(first.reason)).toBeInTheDocument();
    expect(screen.getByText(`${first.brand} ${first.model}`)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'None of these' }));
    await user.click(save());
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: 'answerReview', id: first.id, answer: { none: true, seen: reviewSignature(first) } }),
    );
    expect(await screen.findByText(`2 of ${report.review.length}`)).toBeInTheDocument();
  });
});
