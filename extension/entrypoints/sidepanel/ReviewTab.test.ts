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
import { reviewReason } from './reviewReason';

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
    { asin: 'B0AAAAAAA1', title: 'DEWALT DCF891B 20V MAX XR Cordless Impact Wrench with a very long title that runs on and on', price: 189.5, reviews: 10, reasons: [], seenAt: 1 },
    { asin: 'B0AAAAAAA2', title: 'DEWALT DCF891B Bare Tool', price: null, reviews: 3, reasons: [], seenAt: 1 },
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
    expect(screen.getByText('Which parts come in this bundle?', { selector: 'legend' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('DEWALT 20V MAX Cordless 2 Tool Combo Kit')).toBeInTheDocument();
    expect(screen.getByText('DCK240C2')).toHaveClass('figure', 'fig-sm');
    expect(screen.getByText('DEWALT')).toBeInTheDocument();
    expect(screen.getByText('The kit lists two impact wrenches.')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Which parts come in this bundle?' });
    expect(group.tagName).toBe('FIELDSET');
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')!.textContent)).toEqual(['DCF891B + DCB205', 'DCF921B + DCB205', 'Enter the parts', 'None of these']);
    expect(save()).toBeDisabled();
  });

  it('with no readings offers Enter the parts and None of these, and says why', () => {
    setup(reportOf([item({ choices: [] })]));
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual(['Enter the parts', 'None of these']);
    expect(screen.getByText('No reading could be made from the model number or the page. Enter the parts if you know them.')).toBeInTheDocument();
  });

  it('Enter the parts shows a labelled field with a helper line, and Save stays disabled while it is empty', async () => {
    const user = userEvent.setup();
    setup(reportOf([SPLIT]));
    expect(screen.queryByLabelText('Model numbers, separated by commas')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Enter the parts' }));
    const field = screen.getByLabelText('Model numbers, separated by commas');
    expect(screen.getByText('List a part twice if the bundle has two.')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await user.type(field, '  ');
    expect(save()).toBeDisabled();
    await user.type(field, 'pcl500b');
    expect(save()).toBeEnabled();
  });

  it('sends the entry split on commas, trimmed, empty ones dropped, repeats kept, not upper-cased', async () => {
    const user = userEvent.setup();
    const { send } = setup(reportOf([SPLIT]));
    await user.click(screen.getByRole('radio', { name: 'Enter the parts' }));
    await user.type(screen.getByLabelText('Model numbers, separated by commas'), ' pcl500b , ,PCL500B,, DCB205 ');
    await user.click(save());
    expect(send).toHaveBeenCalledWith({ type: 'answerReview', id: 'split:a', answer: { parts: ['pcl500b', 'PCL500B', 'DCB205'], seen: reviewSignature(SPLIT) } });
  });

  it('shows the worker refusal of typed parts and keeps the entry', async () => {
    const user = userEvent.setup();
    setup(reportOf([SPLIT]), { ok: false, error: '"bad" is not a model number. Enter model numbers like PCL500B, separated by commas.' });
    await user.click(screen.getByRole('radio', { name: 'Enter the parts' }));
    await user.type(screen.getByLabelText('Model numbers, separated by commas'), 'bad');
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('"bad" is not a model number. Enter model numbers like PCL500B, separated by commas.');
    expect(screen.getByLabelText('Model numbers, separated by commas')).toHaveValue('bad');
  });

  it('a match question does not offer Enter the parts', () => {
    setup(reportOf([MATCH]));
    expect(screen.queryByRole('radio', { name: 'Enter the parts' })).toBeNull();
  });

  it('Enter on a radio does not save; the Save button still does with Enter and with Space', async () => {
    const user = userEvent.setup();
    const { send } = setup(reportOf([SPLIT]));
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.keyboard('{Enter}');
    expect(send).not.toHaveBeenCalled();
    save().focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it('Space on the Save button saves', async () => {
    const user = userEvent.setup();
    const { send } = setup(reportOf([SPLIT]));
    await user.click(screen.getAllByRole('radio')[0]!);
    save().focus();
    await user.keyboard(' ');
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it('sends the chosen index with the signature of the question as shown, then moves on', async () => {
    const user = userEvent.setup();
    const { send, again } = setup(reportOf([SPLIT, MATCH]));
    await user.click(screen.getByRole('radio', { name: 'DCF921B + DCB205' }));
    expect(save()).toBeEnabled();
    await user.click(save());
    expect(send).toHaveBeenCalledWith({ type: 'answerReview', id: 'split:a', answer: { choice: 1, seen: reviewSignature(SPLIT) } });
    // The next question is shown before the report reloads, and the count falls with the badge.
    expect(await screen.findByText('1 of 1')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Which Amazon listing is DEWALT DCF891B?' })).toBeInTheDocument();
    expect(save()).toBeDisabled();
    // The reload drops the answered item: still on the second question, still "1 of 1".
    again(reportOf([MATCH]));
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });

  it('shows a question again when a later scan reopens it with other choices, and not when it is unchanged', async () => {
    const user = userEvent.setup();
    const { again } = setup(reportOf([SPLIT]));
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    expect(await screen.findByText('Nothing needs your answer.')).toBeInTheDocument();
    again(reportOf([SPLIT]));
    expect(screen.getByText('Nothing needs your answer.')).toBeInTheDocument();
    const reopened = item({ choices: [['DCF891B', 'DCB606']], reason: 'The page names another battery.', openedAt: 5 });
    again(reportOf([reopened]));
    expect(screen.getByText('The page names another battery.')).toBeInTheDocument();
    expect(screen.getByText('DCF891B + DCB606')).toBeInTheDocument();
  });

  it('moves focus to the next question, or to the empty sentence, and announces the count politely', async () => {
    const user = userEvent.setup();
    const { again } = setup(reportOf([SPLIT, MATCH]));
    expect(screen.getByText('1 of 2')).toHaveAttribute('aria-live', 'polite');
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    await waitFor(() => expect(screen.getByText('Which Amazon listing is DEWALT DCF891B?', { selector: 'legend' })).toHaveFocus());
    again(reportOf([MATCH]));
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    await waitFor(() => expect(screen.getByText('Nothing needs your answer.')).toHaveFocus());
  });

  it('a report reload takes no focus, and neither does a question that remounts because it changed', async () => {
    const user = userEvent.setup();
    const { again } = setup(reportOf([SPLIT, MATCH]));
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    await waitFor(() => expect(screen.getByText('Which Amazon listing is DEWALT DCF891B?', { selector: 'legend' })).toHaveFocus());
    // The owner moves on to something else; the report reloads and the question changes under them.
    (document.activeElement as HTMLElement).blur();
    again(reportOf([{ ...MATCH, reason: 'Another listing appeared.', candidates: [...MATCH.candidates, { asin: 'B0AAAAAAA3', title: 'Third', price: 1, reviews: 1, reasons: [], seenAt: 1 }] }]));
    expect(screen.getByText('Another listing appeared.')).toBeInTheDocument();
    expect(document.body).toHaveFocus();
    // Answering the last one focuses the empty sentence; a reload afterwards does not move focus again.
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    await waitFor(() => expect(screen.getByText('Nothing needs your answer.')).toHaveFocus());
    (document.activeElement as HTMLElement).blur();
    again(reportOf([]));
    expect(document.body).toHaveFocus();
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
    expect(screen.getByText('OLDER')).toBeInTheDocument();
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
    // The link is not part of the radio's label: the radio is named by its title alone.
    expect(link.closest('label')).toBeNull();
    expect(screen.getByRole('radio', { name: MATCH.candidates[1]!.title })).toBeInTheDocument();
  });

  it('sets real prices in mono and "No price seen" in words', () => {
    setup(reportOf([MATCH]));
    expect(screen.getByText('$189.50')).toHaveClass('figure');
    expect(screen.getByText('No price seen')).not.toHaveClass('figure');
  });

  it('sets model numbers in the reason in mono', () => {
    setup(reportOf([item({ reason: 'model number says DCB606, DCK200D1P1; page says DCF921B' })]));
    for (const m of ['DCB606', 'DCK200D1P1', 'DCF921B']) expect(screen.getByText(m)).toHaveClass('figure');
    expect(document.querySelector('.review-reason')!.textContent).toBe(
      'The model number says DCB606, DCK200D1P1. The Home Depot page says DCF921B.',
    );
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

  it('a refusal is cleared when a scan starts, and does not come back when it ends', async () => {
    const user = userEvent.setup();
    const { again } = setup(reportOf([SPLIT]), { ok: false, error: 'That question was already answered.' });
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    await screen.findByRole('alert');
    again(reportOf([SPLIT]), state({ scanRunning: true }));
    expect(screen.queryByRole('alert')).toBeNull();
    again(reportOf([SPLIT]), state({ scanRunning: false }));
    expect(screen.queryByRole('alert')).toBeNull();
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
    expect(screen.getByText(reviewReason(first.reason))).toBeInTheDocument();
    expect(first.reason).toContain('hyphen split');
    expect(screen.getByText('The model number names its parts, but not all of them are known products yet.')).toBeInTheDocument();
    expect(screen.getByText(first.model)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'None of these' }));
    await user.click(save());
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: 'answerReview', id: first.id, answer: { none: true, seen: reviewSignature(first) } }),
    );
    expect(await screen.findByText(`1 of ${report.review.length - 1}`)).toBeInTheDocument();
  });
});

describe('ReviewTab: Skip for now and what None of these does', () => {
  const skipForNow = () => screen.getByRole('button', { name: 'Skip for now' });
  const legend = (t: string) => screen.getByText(t, { selector: 'legend' });
  const SPLIT_Q = 'Which parts come in this bundle?';
  const MATCH_Q = 'Which Amazon listing is DEWALT DCF891B?';

  it('sends no message and shows the next question, the count unchanged', async () => {
    const user = userEvent.setup();
    const { send } = setup(reportOf([SPLIT, MATCH]));
    await user.click(skipForNow());
    expect(send).not.toHaveBeenCalled();
    expect(legend(MATCH_Q)).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
  });

  it('counts three questions through skip, skip, skip, answer: M is the badge, N the place in the round', async () => {
    const user = userEvent.setup();
    const third = item({ id: 'split:c', model: 'DCK999', openedAt: 3, reason: 'Third.', choices: [['DCF891B']] });
    setup(reportOf([SPLIT, MATCH, third]));
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    await user.click(skipForNow());
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    await user.click(skipForNow());
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
    await user.click(skipForNow());
    // Every question has been put off: the round starts again at the first one put off.
    expect(legend(SPLIT_Q)).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    expect(await screen.findByText('1 of 2')).toBeInTheDocument();
  });

  it('counts skip, skip, answer as 1 of 3, 2 of 3, 3 of 3, then 1 of 2, and a skip as 2 of 2', async () => {
    const user = userEvent.setup();
    const third = item({ id: 'split:c', model: 'DCK999', openedAt: 3, reason: 'Third.', choices: [['DCF891B']] });
    setup(reportOf([SPLIT, MATCH, third]));
    const shown = () => screen.getByText(/^\d+ of \d+$/).textContent!;
    const seen: string[] = [shown()];
    await user.click(skipForNow());
    seen.push(shown());
    await user.click(skipForNow());
    seen.push(shown());
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    await screen.findByText('1 of 2');
    seen.push(shown());
    await user.click(skipForNow());
    seen.push(shown());
    expect(seen).toEqual(['1 of 3', '2 of 3', '3 of 3', '1 of 2', '2 of 2']);
    // N never exceeds M.
    for (const c of seen) {
      const [n, m] = c.split(' of ').map(Number);
      expect(n!).toBeLessThanOrEqual(m!);
    }
  });

  it('brings a skipped question back after the others, and again when only skipped ones remain', async () => {
    const user = userEvent.setup();
    const third = item({ id: 'split:c', model: 'DCK999', openedAt: 3, reason: 'Third.', choices: [['DCF891B']] });
    setup(reportOf([SPLIT, MATCH, third]));
    await user.click(skipForNow());
    await user.click(skipForNow());
    expect(screen.getByText('Third.')).toBeInTheDocument();
    await user.click(skipForNow());
    expect(legend(SPLIT_Q)).toBeInTheDocument();
    expect(screen.getByText('DCK240C2')).toBeInTheDocument();
    await user.click(skipForNow());
    expect(legend(MATCH_Q)).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
  });

  it('keeps a single question on screen', async () => {
    const user = userEvent.setup();
    const { send } = setup(reportOf([SPLIT]));
    await user.click(skipForNow());
    expect(legend(SPLIT_Q)).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('moves focus to the next question', async () => {
    const user = userEvent.setup();
    setup(reportOf([SPLIT, MATCH]));
    await user.click(skipForNow());
    await waitFor(() => expect(legend(MATCH_Q)).toHaveFocus());
  });

  it('is disabled while a Save answer is in flight', async () => {
    const user = userEvent.setup();
    let release: (r: Reply) => void = () => {};
    const send = vi.fn(() => new Promise<Reply>((r) => (release = r)));
    const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    render(createElement(ReviewTab, { api, report: reportOf([SPLIT, MATCH]), state: state() }));
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(save());
    expect(skipForNow()).toBeDisabled();
    release({ ok: true, data: null });
    await waitFor(() => expect(legend(MATCH_Q)).toBeInTheDocument());
  });

  it('stays enabled while a scan runs', async () => {
    const user = userEvent.setup();
    const { send } = setup(reportOf([SPLIT, MATCH]), undefined, state({ scanRunning: true }));
    expect(skipForNow()).toBeEnabled();
    await user.click(skipForNow());
    expect(legend(MATCH_Q)).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('says what None of these does, on a split and on a match question, tied to the radio', () => {
    setup(reportOf([SPLIT]));
    let none = screen.getByRole('radio', { name: 'None of these' });
    const line = screen.getByText('The bundle stays in Contents not known.');
    expect(none).toHaveAttribute('aria-describedby', line.id);
    expect(none).toHaveAccessibleDescription('The bundle stays in Contents not known.');
    cleanup();
    setup(reportOf([MATCH]));
    none = screen.getByRole('radio', { name: 'None of these' });
    expect(none).toHaveAccessibleDescription('The part stays without a listing.');
  });
});
