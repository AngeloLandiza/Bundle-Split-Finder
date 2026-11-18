// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnswerRefused, applyReviewAnswer, reviewSignature } from '@core/scan/answers';
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
import { STALE_REFUSALS, suggestedOf } from './AcceptSuggested';
import { ReviewTab } from './ReviewTab';

afterEach(cleanup);

const state = (over: Partial<AppState> = {}): AppState => ({
  hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS,
  scanRunning: false, lastJob: null, nextRunAt: null, ...over,
});

// The recorded replay, as the panel's own scan reads it: every split question it opens, with the choices it offered.
let real: ReviewItem[] = [];
beforeAll(async () => {
  const T0 = Date.UTC(2026, 10, 9, 12);
  const store = new MemoryScanStore();
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 20 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
  await runScan({ client, budget, store, settings: DEFAULT_SCAN_SETTINGS, now: () => T0 });
  real = ((await buildReport(store, DEFAULT_SCAN_SETTINGS)) as unknown as PanelReport).review;
}, 60_000);

const reportOf = (review: ReviewItem[]) => ({ bundles: [], review, packaging: {} }) as unknown as PanelReport;
const oneReading = () => real.filter((r) => r.kind === 'split' && r.choices.length === 1);
const manyOrNone = () => real.filter((r) => r.kind === 'split' && r.choices.length !== 1);

type Handler = (r: Extract<Request, { type: 'answerReview' }>) => Reply | Promise<Reply>;
function setup(report: PanelReport, handler: Handler = () => ({ ok: true, data: null }), st: AppState = state()) {
  const send = vi.fn(async (r: Request): Promise<Reply> => handler(r as Extract<Request, { type: 'answerReview' }>));
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
  const view = render(createElement(ReviewTab, { api, report, state: st }));
  const again = (next: PanelReport, s: AppState = st) => view.rerender(createElement(ReviewTab, { api, report: next, state: s }));
  return { send, again };
}
const acceptButton = () => screen.getByRole('button', { name: /^Accept(ing| all)/ });

describe('Accept all: which questions, and what the block says', () => {
  it('the recorded replay offers enough one-reading questions to test with', () => {
    expect(oneReading().length).toBeGreaterThan(3);
    expect(manyOrNone().length).toBeGreaterThan(0);
  });

  it('lists every open split question with exactly one reading, and none with no reading or a match question', () => {
    const mixed = [...real, { ...oneReading()[0]!, id: 'match:x', kind: 'match' as const }];
    expect(suggestedOf(mixed).map((r) => r.id)).toEqual(oneReading().map((r) => r.id));
  });

  it('shows the heading, one line per bundle with the model and its parts in the figure face, the button and the note', () => {
    const pair = oneReading().slice(0, 2);
    setup(reportOf([...manyOrNone(), ...pair]));
    expect(screen.getByRole('heading', { name: '2 bundles have one suggested answer' })).toBeInTheDocument();
    const list = screen.getByRole('list');
    expect(list.tagName).toBe('UL');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    for (const [i, r] of pair.entries()) {
      expect(within(rows[i]!).getByText(r.model)).toHaveClass('figure');
      expect(within(rows[i]!).getByText(r.choices[0]!.join(' + '))).toHaveClass('figure');
    }
    expect(acceptButton()).toHaveTextContent('Accept all 2');
    expect(acceptButton().tagName).toBe('BUTTON');
    expect(acceptButton()).toBeEnabled();
    expect(screen.getByText('Each bundle gets the parts shown. Questions with more than one answer stay below.')).toBeInTheDocument();
  });

  it('is above the one-at-a-time question, which still shows every open question in its count', () => {
    setup(reportOf(real));
    expect(screen.getByText(`1 of ${real.length}`)).toBeInTheDocument();
    const heading = screen.getByRole('heading', { name: `${oneReading().length} bundles have one suggested answer` });
    const question = screen.getByRole('group', { name: 'Which parts come in this bundle?' });
    expect(heading.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not shown for one such question, or for questions with more than one reading', () => {
    setup(reportOf([...manyOrNone(), oneReading()[0]!]));
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
    cleanup();
    const twoReadings = (r: ReviewItem): ReviewItem => ({ ...r, choices: [r.choices[0]!, ['OTHER1', 'OTHER2']] });
    setup(reportOf(oneReading().slice(0, 3).map(twoReadings)));
    expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
  });
});

describe('Accept all: the run', () => {
  it('sends answerReview with choice 0 and each question\'s own seen, one after another, in the order listed', async () => {
    const user = userEvent.setup();
    const pair = oneReading().slice(0, 3);
    const { send } = setup(reportOf(pair));
    await user.click(acceptButton());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls.map((c) => c[0])).toEqual(pair.map((r) => ({ type: 'answerReview', id: r.id, answer: { choice: 0, seen: reviewSignature(r) } })));
  });

  it('waits for each reply before sending the next, and the button reads Accepting i of N and is disabled meanwhile', async () => {
    const user = userEvent.setup();
    const trio = oneReading().slice(0, 3);
    const gates: ((r: Reply) => void)[] = [];
    const { send } = setup(reportOf(trio), () => new Promise<Reply>((r) => gates.push(r)));
    await user.click(acceptButton());
    expect(send).toHaveBeenCalledTimes(1);
    expect(acceptButton()).toHaveTextContent('Accepting 1 of 3…');
    expect(acceptButton()).toBeDisabled();
    gates[0]!({ ok: true, data: null });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(acceptButton()).toHaveTextContent('Accepting 2 of 3…');
    // The list keeps the bundles the run started with, though the first is already answered.
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3);
    gates[1]!({ ok: true, data: null });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    gates[2]!({ ok: true, data: null });
    expect(await screen.findByText('Accepted 3 of 3.')).toBeInTheDocument();
  });

  it('when every one is saved, says Accepted N of N, moves focus to that sentence, and leaves only the sentence and the rest', async () => {
    const user = userEvent.setup();
    const pair = oneReading().slice(0, 2);
    const { again } = setup(reportOf(pair));
    await user.click(acceptButton());
    const sentence = await screen.findByText('Accepted 2 of 2.');
    await waitFor(() => expect(sentence).toHaveFocus());
    expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
    expect(screen.getByText('Nothing needs your answer.')).toBeInTheDocument();
    // The report reloads without them: nothing moves.
    again(reportOf([]));
    expect(screen.getByText('Accepted 2 of 2.')).toHaveFocus();
  });

  it('answered bundles leave the question below at once, and the count falls', async () => {
    const user = userEvent.setup();
    const rest = manyOrNone().slice(0, 2);
    const pair = oneReading().slice(0, 2);
    setup(reportOf([...pair, ...rest]));
    expect(screen.getByText('1 of 4')).toBeInTheDocument();
    await user.click(acceptButton());
    expect(await screen.findByText('Accepted 2 of 2.')).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
    // The one-at-a-time question stays usable.
    await user.click(screen.getByRole('radio', { name: 'None of these' }));
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeEnabled();
  });

  it('a question answered elsewhere (stale) is not answered, is counted, and the rest still save (Review Focus 3)', async () => {
    const user = userEvent.setup();
    const [a, b, c] = oneReading();
    const { send, again } = setup(reportOf([a!, b!, c!]), (r) =>
      r.id === b!.id ? { ok: false, error: 'That question changed. Choose again.' } : { ok: true, data: null },
    );
    await user.click(acceptButton());
    expect(await screen.findByText('Accepted 2 of 3. 1 had changed and is still open.')).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(3);
    // Only the stale one is still open: one question is not a block, so the question below is that bundle.
    expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
    expect(screen.getByText(b!.model)).toBeInTheDocument();
    // The report reloads as the worker would have it: only the stale one remains.
    again(reportOf([b!]));
    expect(screen.getByText('Accepted 2 of 3. 1 had changed and is still open.')).toBeInTheDocument();
  });

  it('counts a question already answered or gone as skipped too', async () => {
    const user = userEvent.setup();
    const [a, b, c] = oneReading();
    setup(reportOf([a!, b!, c!]), (r) =>
      r.id === a!.id ? { ok: false, error: 'That question was already answered.' } : r.id === b!.id ? { ok: false, error: 'That question was not found.' } : { ok: true, data: null },
    );
    await user.click(acceptButton());
    expect(await screen.findByText('Accepted 1 of 3. 2 were no longer open.')).toBeInTheDocument();
  });

  it('says is/was for one and are/were for several, changed ones first, then the ones no longer open', async () => {
    const user = userEvent.setup();
    const four = oneReading().slice(0, 4);
    setup(reportOf(four), (r) =>
      r.id === four[0]!.id || r.id === four[1]!.id
        ? { ok: false, error: 'That question changed. Choose again.' }
        : r.id === four[2]!.id
          ? { ok: false, error: 'That question was already answered.' }
          : { ok: true, data: null },
    );
    await user.click(acceptButton());
    expect(await screen.findByText('Accepted 1 of 4. 2 had changed and are still open. 1 was no longer open.')).toBeInTheDocument();
  });

  it('any other refusal stops the run and shows its sentence, leaving the rest unanswered', async () => {
    const user = userEvent.setup();
    const [a, b, c] = oneReading();
    const { send } = setup(reportOf([a!, b!, c!]), (r) =>
      r.id === b!.id ? { ok: false, error: 'A scan is running. Answer again when it has finished.' } : { ok: true, data: null },
    );
    await user.click(acceptButton());
    const sentence = await screen.findByText('Accepted 1 of 3. A scan is running. Answer again when it has finished.');
    expect(sentence).toHaveFocus();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((x) => (x[0] as { id: string }).id)).toEqual([a!.id, b!.id]);
    // The first was saved; the second and third are still open, so the block stays and can be pressed again.
    expect(screen.getByRole('heading', { name: '2 bundles have one suggested answer' })).toBeInTheDocument();
    expect(acceptButton()).toBeEnabled();
  });

  it('a worker that cannot be reached stops the run with the panel\'s sentence', async () => {
    const user = userEvent.setup();
    const pair = oneReading().slice(0, 2);
    const send = vi.fn(async () => {
      throw new Error('gone');
    });
    const api: WorkerApi = { send: send as unknown as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    render(createElement(ReviewTab, { api, report: reportOf(pair), state: state() }));
    await user.click(acceptButton());
    expect(await screen.findByText(`Accepted 0 of 2. ${UNREACHABLE}`)).toHaveFocus();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('while a scan runs the button is disabled and says why, and sends nothing', async () => {
    const user = userEvent.setup();
    const { send } = setup(reportOf(oneReading().slice(0, 2)), undefined, state({ scanRunning: true }));
    expect(acceptButton()).toBeDisabled();
    // The question below says the same; this one is the block's own line.
    expect(within(screen.getByRole('region', { name: /one suggested answer/ })).getByText('A scan is running. Answer when it has finished.')).toBeInTheDocument();
    await user.click(acceptButton());
    expect(send).not.toHaveBeenCalled();
  });

  it('the result stays when the block has gone, until the tab is left (the panel unmounts it)', async () => {
    const user = userEvent.setup();
    const [a, b, c] = oneReading();
    const { again } = setup(reportOf([a!, b!, c!]));
    await user.click(acceptButton());
    await screen.findByText('Accepted 3 of 3.');
    again(reportOf([]));
    expect(screen.getByText('Accepted 3 of 3.')).toBeInTheDocument();
    cleanup();
    setup(reportOf([]));
    expect(screen.queryByText('Accepted 3 of 3.')).toBeNull();
  });
});

describe('Accept all: focus, leaving, and the fold', () => {
  it('the result takes focus once: a report reload that remounts the block does not take it back', async () => {
    const user = userEvent.setup();
    const pair = oneReading().slice(0, 2);
    const { again } = setup(reportOf(pair));
    await user.click(acceptButton());
    const sentence = await screen.findByText('Accepted 2 of 2.');
    await waitFor(() => expect(sentence).toHaveFocus());
    (document.activeElement as HTMLElement).blur();
    // A scan brings new questions: the tab goes from the empty state to a question, and the block remounts.
    again(reportOf(manyOrNone().slice(0, 1)));
    expect(screen.getByText('Accepted 2 of 2.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Which parts come in this bundle?' })).toBeInTheDocument();
    expect(document.body).toHaveFocus();
    // Back to a block with the result still on screen: still not focused.
    again(reportOf([...manyOrNone().slice(0, 1), ...oneReading().slice(0, 2)]));
    expect(document.body).toHaveFocus();
  });

  it('leaving the tab mid-run stops the loop before the next send', async () => {
    const user = userEvent.setup();
    const trio = oneReading().slice(0, 3);
    const gates: ((r: Reply) => void)[] = [];
    const { send } = setup(reportOf(trio), () => new Promise<Reply>((r) => gates.push(r)));
    await user.click(acceptButton());
    expect(send).toHaveBeenCalledTimes(1);
    cleanup();
    gates[0]!({ ok: true, data: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('shows three rows and Show all N when there are more; Show all N and Show fewer toggle, with aria-expanded', async () => {
    const user = userEvent.setup();
    const n = oneReading().length;
    setup(reportOf(real));
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3);
    const toggle = screen.getByRole('button', { name: `Show all ${n}` });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The toggle is under the rows and above Accept all, so the button stays near the top.
    expect(toggle.compareDocumentPosition(acceptButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(toggle);
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(n);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3);
  });

  it('has no toggle for three rows or fewer', () => {
    setup(reportOf(oneReading().slice(0, 3)));
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^Show/ })).toBeNull();
  });

  it('Accept all N accepts every question, not only the rows shown', async () => {
    const user = userEvent.setup();
    const all = oneReading();
    const { send } = setup(reportOf(all));
    await user.click(acceptButton());
    expect(await screen.findByText(`Accepted ${all.length} of ${all.length}.`)).toBeInTheDocument();
    expect(send.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(all.map((r) => r.id));
  });
});

describe('Accept all: the refusals it skips are the worker\'s own', () => {
  it('STALE_REFUSALS are the sentences applyReviewAnswer gives for a changed, an answered and a missing question', async () => {
    const q = oneReading()[0]!;
    const store = new MemoryScanStore();
    await store.putReview({ ...q });
    const said = async (id: string, seen: string): Promise<string> => {
      try {
        await applyReviewAnswer(store, id, { choice: 0, seen }, 1);
      } catch (e) {
        if (e instanceof AnswerRefused) return e.message;
        throw e;
      }
      return 'saved';
    };
    const changed = await said(q.id, 'stale');
    expect(await said(q.id, reviewSignature(q))).toBe('saved');
    const answered = await said(q.id, reviewSignature(q));
    const missing = await said('split:homedepot:nothing', '[]');
    expect([changed, answered, missing].sort()).toEqual([...STALE_REFUSALS].sort());
  });
});
