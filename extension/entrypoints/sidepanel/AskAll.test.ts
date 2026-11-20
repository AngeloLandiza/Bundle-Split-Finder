// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type StoredSuggestion, suggestionKey } from '@core/assist/stored';
import type { Suggestion } from '@core/assist/types';
import { reviewSignature } from '@core/scan/answers';
import type { ReviewItem } from '@core/scan/types';
import { DEFAULT_SETTINGS } from '@core/settings';
import { asked, assistWorld } from '../../../core/test/assist-world';
import type { AppState, AskAllResult, PanelReport, Reply, Request } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { ReviewTab } from './ReviewTab';
import { askAllSentence } from './AskAll';
import { researchCostLabel } from '@core/research/eval';

// Step 12, R3: the Review tab with Ask AI about all, the "AI suggestions" section and Approve all. Real questions of the validation replay.

afterEach(cleanup);

const A = 'split:homedepot:339206615';
const B = 'split:homedepot:344285193';
const C = 'split:homedepot:342303258';
const D = 'split:homedepot:341644756';
const NO_READING = 'split:homedepot:314716732';
const MATCH = 'match:RYOBI:P553';

const state = (over: Partial<AppState> = {}): AppState => ({
  hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS,
  scanRunning: false, lastJob: null, nextRunAt: null,
  ebay: { hasEbayKeys: false, hasAnthropicKey: true, judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 60 },
  ...over,
});
const reportOf = (review: ReviewItem[], aiSuggestions: StoredSuggestion[] = []) => ({ bundles: [], review, packaging: {}, aiSuggestions }) as unknown as PanelReport;

const quoteOf = (q: ReviewItem) => ({ quote: `Includes ${q.choices[0]?.join(' and ') ?? 'the parts'}.`, sourceId: 'bundle', label: 'Home Depot page', url: `https://www.homedepot.com/p/${q.subject.replace('homedepot:', '')}`, names: true });
const base = (q: ReviewItem) => ({ questionId: q.id, seen: reviewSignature(q), provider: 'claude', model: 'claude-haiku-5-5', promptVersion: 'v' });
const record = (q: ReviewItem, suggestion: Suggestion, at = 1): StoredSuggestion => ({ key: suggestionKey(q.id, at), questionId: q.id, seen: reviewSignature(q), askedAt: at, suggestion, costUsd: 0.01 });
const verifiedReading = (q: ReviewItem): StoredSuggestion =>
  record(q, { ...base(q), status: 'verified', reason: 'r', quotes: [quoteOf(q)], answer: { decision: 'choose', kind: 'split', choiceIndex: 0, parts: q.choices[0]! } });
const verifiedParts = (q: ReviewItem, parts: { model: string; qty: number }[]): StoredSuggestion =>
  record(q, { ...base(q), status: 'verified', reason: 'r', quotes: [quoteOf(q)], answer: { decision: 'parts', kind: 'split', parts: parts.flatMap((p) => Array.from({ length: p.qty }, () => p.model)) } });
const cannotTell = (q: ReviewItem): StoredSuggestion => record(q, { ...base(q), status: 'cannot_tell', reason: 'The page does not list the parts.', quotes: [] });
const unverified = (q: ReviewItem): StoredSuggestion =>
  record(q, { ...base(q), status: 'unverified', reasons: ['The quote is not found.'], claimed: { evidence: [], reason: 'x', decision: 'choose', choiceIndex: 0, asin: null } });

function setup(report: PanelReport, over: { state?: AppState; answers?: Partial<Record<Request['type'], Reply>>; send?: (r: Request) => Promise<Reply> } = {}) {
  const calls: Request[] = [];
  const send = vi.fn(async (r: Request): Promise<Reply> => {
    calls.push(r);
    if (over.send) return over.send(r);
    return over.answers?.[r.type] ?? { ok: true, data: null };
  });
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
  const ui = render(createElement(ReviewTab, { api, report, state: over.state ?? state() }));
  return { calls, send, ui, rerender: (next: { report?: PanelReport; state?: AppState }) => ui.rerender(createElement(ReviewTab, { api, report: next.report ?? report, state: next.state ?? over.state ?? state() })) };
}

const world = async () => {
  const w = await assistWorld();
  const q = (id: string, openedAt: number): ReviewItem => ({ ...asked(w, id), openedAt });
  return { a: q(A, 1), b: q(B, 2), c: q(C, 3), d: q(D, 4), none: q(NO_READING, 5), match: q(MATCH, 6) };
};
const section = () => screen.getByRole('region', { name: /AI suggestions/ });
const askAllButton = () => screen.getByRole('button', { name: /^(Ask AI about all|Asking…)/ });

describe('the "AI suggestions" section', () => {
  it('is above the questions and lists only verified suggestions, one compact row each: name on one line, the answer in the figure face, one quote with its source', async () => {
    const { a, b, c, d } = await world();
    setup(reportOf([a, b, c, d], [verifiedReading(a), verifiedReading(b), cannotTell(c), unverified(d)]));
    const s = section();
    expect(within(s).getByRole('heading', { name: 'AI suggestions · 2' })).toBeVisible();
    const rows = within(s).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // The name is the bundle's own title, cut to one line by the style (checked in the css test); the answer is a figure.
    expect(within(rows[0]!).getByText(a.title!)).toBeVisible();
    expect(within(rows[0]!).getByText(a.choices[0]!.join(' + '))).toHaveClass('figure');
    expect(within(rows[0]!).getByText(quoteOf(a).quote)).toBeVisible();
    const link = within(rows[0]!).getByRole('link', { name: 'Home Depot page' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    // The section comes before the question list.
    expect(s.compareDocumentPosition(screen.getByText(/^1 of 2$/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // "Could not tell" and unverified stay in the list below, with their block; the count of the list is theirs alone.
    expect(screen.getByText(/^1 of 2$/)).toBeVisible();
    expect(screen.getByRole('group', { name: 'AI suggestion' })).toHaveTextContent('AI could not tell from the page');
  });

  it('a row opens to the full suggestion and the question\'s controls, and closes again', async () => {
    const { a, b } = await world();
    setup(reportOf([a, b], [verifiedReading(a)]));
    const head = within(section()).getByRole('button', { expanded: false });
    expect(within(section()).queryByRole('group', { name: 'AI suggestion' })).toBeNull();
    await userEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'true');
    const open = within(section());
    expect(open.getByRole('group', { name: 'AI suggestion' })).toBeVisible();
    expect(open.getByRole('radio', { name: a.choices[0]!.join(' + ') })).toBeChecked();
    expect(open.getByRole('button', { name: 'Approve' })).toBeEnabled();
    await userEvent.click(head);
    expect(within(section()).queryByRole('group', { name: 'AI suggestion' })).toBeNull();
  });

  it('answering from an open row saves it as an approval, and the row goes', async () => {
    const { a, b } = await world();
    const { calls } = setup(reportOf([a, b], [verifiedReading(a)]));
    await userEvent.click(within(section()).getByRole('button', { expanded: false }));
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve' }));
    expect(calls).toEqual([{ type: 'answerReview', id: a.id, answer: { choice: 0, seen: reviewSignature(a) }, aiSuggestion: true }]);
    await waitFor(() => expect(screen.queryByRole('region', { name: /AI suggestions/ })).toBeNull());
  });

  it('is not there with no verified suggestion', async () => {
    const { a, b } = await world();
    setup(reportOf([a, b], [cannotTell(a), unverified(b)]));
    expect(screen.queryByRole('region', { name: /AI suggestions/ })).toBeNull();
  });

  it('a verified suggestion for a question as it was is not a row: it was made for other readings', async () => {
    const { a, b } = await world();
    setup(reportOf([a, b], [{ ...verifiedReading(a), seen: JSON.stringify([['OTHER']]) }]));
    expect(screen.queryByRole('region', { name: /AI suggestions/ })).toBeNull();
  });

  it('shows parts the AI found with their counts, and an open row has them typed in, ready to approve', async () => {
    const { none, b } = await world();
    setup(reportOf([none, b], [verifiedParts(none, [{ model: 'DCK940D2', qty: 1 }, { model: 'DCB203', qty: 2 }])]));
    const row = within(section()).getAllByRole('listitem')[0]!;
    expect(within(row).getByText('DCK940D2 + 2 × DCB203')).toHaveClass('figure');
    await userEvent.click(within(row).getByRole('button', { expanded: false }));
    expect(within(row).getByRole('radio', { name: 'Enter the parts' })).toBeChecked();
    expect(within(row).getByRole('textbox')).toHaveValue('DCK940D2, DCB203, DCB203');
    expect(within(row).getByRole('button', { name: 'Approve' })).toBeEnabled();
    // Editing what the AI typed makes it the owner's own answer.
    await userEvent.type(within(row).getByRole('textbox'), ', DCB203');
    expect(within(row).getByRole('button', { name: 'Save answer' })).toBeEnabled();
  });
});

describe('Approve all verified', () => {
  it('is a secondary button in the section header that says how many; nothing is sent by it', async () => {
    const { a, b, c } = await world();
    const { calls } = setup(reportOf([a, b, c], [verifiedReading(a), verifiedReading(b), cannotTell(c)]));
    const button = within(section()).getByRole('button', { name: 'Approve all 2 verified' });
    expect(button).toHaveClass('btn-secondary');
    await userEvent.click(button);
    // A question first, inline: "Approve 2 AI answers?" with Approve and Cancel. Still nothing sent.
    expect(within(section()).getByText('Approve 2 AI answers?')).toBeVisible();
    expect(within(section()).getByRole('button', { name: 'Approve' })).toHaveFocus();
    expect(within(section()).getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(calls).toEqual([]);
  });

  it('Cancel sends nothing and puts the button back, with focus', async () => {
    const { a, b } = await world();
    const { calls } = setup(reportOf([a, b], [verifiedReading(a), verifiedReading(b)]));
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve all 2 verified' }));
    await userEvent.click(within(section()).getByRole('button', { name: 'Cancel' }));
    expect(calls).toEqual([]);
    expect(within(section()).queryByText('Approve 2 AI answers?')).toBeNull();
    expect(within(section()).getByRole('button', { name: 'Approve all 2 verified' })).toHaveFocus();
  });

  it('Approve sends exactly the verified answers shown, each marked as an approval of a suggestion, and none for any other question', async () => {
    const { a, b, c, d, none } = await world();
    const parts = [{ model: 'DCK940D2', qty: 1 }, { model: 'DCB203', qty: 2 }];
    const { calls } = setup(reportOf([a, b, c, d, none], [verifiedReading(a), verifiedParts(none, parts), verifiedReading(b), cannotTell(c), unverified(d)]));
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve all 3 verified' }));
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved 3 of 3.');
    expect(calls).toEqual([
      { type: 'answerReview', id: a.id, answer: { choice: 0, seen: reviewSignature(a) }, aiSuggestion: true },
      { type: 'answerReview', id: b.id, answer: { choice: 0, seen: reviewSignature(b) }, aiSuggestion: true },
      { type: 'answerReview', id: none.id, answer: { parts: ['DCK940D2', 'DCB203', 'DCB203'], seen: reviewSignature(none) }, aiSuggestion: true },
    ]);
    // The ones that were not verified are still open and untouched.
    expect(screen.queryByRole('region', { name: /AI suggestions/ })).toBeNull();
    expect(screen.getByText(/^1 of 2$/)).toBeVisible();
  });

  it('takes focus to its one-sentence result', async () => {
    const { a, b } = await world();
    setup(reportOf([a, b], [verifiedReading(a), verifiedReading(b)]));
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve all 2 verified' }));
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve' }));
    const result = await screen.findByText('Approved 2 of 2.');
    await waitFor(() => expect(result).toHaveFocus());
  });

  it('counts a question that changed or was answered meanwhile, says one a worker refused, and goes on with the rest', async () => {
    const { a, b, c } = await world();
    const refusals: Record<string, Reply> = {
      [a.id]: { ok: false, error: 'That question changed. Choose again.' },
      [b.id]: { ok: false, error: 'That question was already answered.' },
      [c.id]: { ok: true, data: null },
    };
    const { calls } = setup(reportOf([a, b, c], [verifiedReading(a), verifiedReading(b), verifiedReading(c)]), { send: async (r) => (r.type === 'answerReview' ? refusals[r.id]! : { ok: true, data: null }) });
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve all 3 verified' }));
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved 1 of 3. 1 had changed and is still open. 1 was no longer open.');
    expect(calls).toHaveLength(3);
  });

  it('says what the worker refused to save, in its words, and counts the rest as approved', async () => {
    const { a, none } = await world();
    const { calls } = setup(reportOf([a, none], [verifiedReading(a), verifiedParts(none, [{ model: 'NOTAMODEL', qty: 1 }])]), {
      send: async (r) => (r.type === 'answerReview' && r.id === none.id ? { ok: false, error: 'Enter model numbers such as DCB205.' } : { ok: true, data: null }),
    });
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve all 2 verified' }));
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved 1 of 2. 1 could not be saved: Enter model numbers such as DCB205.');
    expect(calls).toHaveLength(2);
  });

  it('stops when a scan has started, saying so, rather than going on', async () => {
    const { a, b } = await world();
    const { calls } = setup(reportOf([a, b], [verifiedReading(a), verifiedReading(b)]), { send: async () => ({ ok: false, error: 'A scan is running. Answer again when it has finished.' }) });
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve all 2 verified' }));
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved 0 of 2. A scan is running. Answer again when it has finished.');
    expect(calls).toHaveLength(1);
  });

  it('is not pressable while a scan runs, and withdraws a question that was open', async () => {
    const { a, b } = await world();
    const ui = setup(reportOf([a, b], [verifiedReading(a), verifiedReading(b)]));
    await userEvent.click(within(section()).getByRole('button', { name: 'Approve all 2 verified' }));
    expect(within(section()).getByText('Approve 2 AI answers?')).toBeVisible();
    ui.rerender({ state: state({ scanRunning: true }) });
    expect(within(section()).queryByText('Approve 2 AI answers?')).toBeNull();
    const button = within(section()).getByRole('button', { name: 'Approve all 2 verified' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(button);
    expect(within(section()).queryByText('Approve 2 AI answers?')).toBeNull();
    expect(ui.calls).toEqual([]);
  });

  it('a question the owner just asked on its own stays in its place until it is answered, as before', async () => {
    const { a, b } = await world();
    const data = verifiedReading(a);
    const { calls } = setup(reportOf([a, b]), { answers: { askAi: { ok: true, data } } });
    await userEvent.click(screen.getByRole('button', { name: /^Ask AI · / }));
    const block = await screen.findByRole('group', { name: 'AI suggestion' });
    expect(screen.queryByRole('region', { name: /AI suggestions/ })).toBeNull();
    expect(block).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(calls).toEqual([{ type: 'askAi', questionId: a.id }]);
  });
});

describe('Accept all stays for questions with no suggestion', () => {
  it('is unchanged beside the section: it answers the ones the AI has not spoken on, and not the ones in the section', async () => {
    const { a, b, c, d } = await world();
    const ONE = 'The model number reads as one reading.';
    const [x, y, z, w] = [a, b, c, d].map((q) => ({ ...q, reason: ONE }));
    const { calls } = setup(reportOf([x!, y!, z!, w!], [verifiedReading(x!)]));
    await userEvent.click(screen.getByRole('button', { name: 'Accept all 3' }));
    await waitFor(() => expect(calls.filter((c) => c.type === 'answerReview')).toHaveLength(3));
    expect(calls.map((c) => (c as { id: string }).id).sort()).toEqual([y!.id, z!.id, w!.id].sort());
    for (const c of calls) expect(c).not.toHaveProperty('aiSuggestion');
  });
});

describe('Ask AI about all', () => {
  it('sits beside Accept all, as a secondary button that says how many and about what it costs', async () => {
    const { a, b, c, d } = await world();
    const ONE = 'The model number reads as one reading.';
    setup(reportOf([a, b, c, d].map((q) => ({ ...q, reason: ONE }))));
    const button = askAllButton();
    expect(button).toHaveClass('btn-secondary');
    expect(button).toHaveAccessibleName(/^Ask AI about all 4 · about \$0\.\d\d$/);
    expect(button.parentElement).toBe(screen.getByRole('button', { name: 'Accept all 4' }).parentElement);
    expect(button.querySelectorAll('.figure')).toHaveLength(2);
  });

  it('is alone at the top when there is no Accept all, and counts only what can be asked: a match question with no listing is not', async () => {
    const { none, match } = await world();
    const noListing = { ...match, id: 'match:RYOBI:ZZ', subject: 'RYOBI:ZZ', model: 'ZZ', candidates: [] };
    setup(reportOf([none, match, noListing]));
    expect(askAllButton()).toHaveAccessibleName(/^Ask AI about all 2 · /);
    expect(screen.queryByRole('button', { name: /^Accept all/ })).toBeNull();
  });

  it('is hidden with no key, with no more than one question to ask (the question has its own button), and when everything has a suggestion', async () => {
    const { a, b, c } = await world();
    setup(reportOf([a, b]), { state: state({ ebay: { hasEbayKeys: false, hasAnthropicKey: false, judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 60 } }) });
    expect(screen.queryByRole('button', { name: /Ask AI/ })).toBeNull();
    cleanup();
    setup(reportOf([a]));
    expect(screen.queryByRole('button', { name: /^Ask AI about all/ })).toBeNull();
    cleanup();
    setup(reportOf([a, b, c], [cannotTell(a), cannotTell(b), cannotTell(c)]));
    expect(screen.queryByRole('button', { name: /^Ask AI about all/ })).toBeNull();
    cleanup();
    // One without a suggestion left among three: the question's own button is enough.
    setup(reportOf([a, b, c], [cannotTell(a), cannotTell(b)]));
    expect(screen.queryByRole('button', { name: /^Ask AI about all/ })).toBeNull();
  });

  it('sends one request for the whole queue and nothing else', async () => {
    const { a, b } = await world();
    const { calls } = setup(reportOf([a, b]), { answers: { askAiAll: { ok: true, data: { queued: 2 } } } });
    await userEvent.click(askAllButton());
    expect(calls).toEqual([{ type: 'askAiAll' }]);
  });

  it('says a refusal in the worker\'s own words', async () => {
    const { a, b } = await world();
    setup(reportOf([a, b]), { answers: { askAiAll: { ok: false, error: 'A scan is running. Ask again when it has finished.' } } });
    await userEvent.click(askAllButton());
    expect(await screen.findByText('A scan is running. Ask again when it has finished.')).toBeVisible();
  });

  it('is not pressable while a scan runs', async () => {
    const { a, b } = await world();
    const { calls } = setup(reportOf([a, b]), { state: state({ scanRunning: true }) });
    expect(askAllButton()).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(askAllButton());
    expect(calls).toEqual([]);
  });

  it('reads Asking… while the queue runs, the panel stays usable, and a question\'s own Ask AI waits', async () => {
    const { a, b } = await world();
    const { calls } = setup(reportOf([a, b]), { state: state({ askAll: { done: 1, total: 2, costUsd: 0.01, estimateUsd: 0.2 } }) });
    expect(askAllButton()).toHaveTextContent('Asking…');
    expect(askAllButton()).toHaveAttribute('aria-disabled', 'true');
    // Nothing preselected, and the owner can answer.
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'None of these' }));
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeEnabled();
    const own = screen.getByRole('button', { name: /^Ask AI · / });
    expect(own).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(own);
    await userEvent.click(askAllButton());
    expect(calls).toEqual([]);
  });

  it('says how it ended, in one sentence', async () => {
    const { a, b } = await world();
    const result: AskAllResult = { total: 26, asked: 26, suggested: 24, verified: 18, costUsd: 0.52, stopped: false, problem: null };
    setup(reportOf([a, b]), { state: state({ askAllResult: result }) });
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Asked 26 questions: 18 verified, 8 left for you. Cost $0.52.');
  });

  it('the sentence says stopped, and why a queue gave up', () => {
    const base: AskAllResult = { total: 26, asked: 7, suggested: 5, verified: 4, costUsd: 0.41, stopped: true, problem: null };
    expect(askAllSentence(base)).toBe('Stopped after 7 of 26: 4 verified. Cost $0.41.');
    expect(askAllSentence({ ...base, asked: 3, costUsd: 0, problem: 'Claude refused the API key (HTTP 401).' })).toBe('Asking stopped after 3 of 26: Claude refused the API key (HTTP 401).');
    expect(askAllSentence({ ...base, stopped: false, asked: 1, total: 1, verified: 1, suggested: 1, costUsd: 0.01 })).toBe('Asked 1 question: 1 verified, 0 left for you. Cost $0.01.');
    expect(askAllSentence({ ...base, stopped: false, asked: 0, total: 3, verified: 0, suggested: 0, costUsd: 0 })).toBe('Nothing was asked.');
  });
});

describe('the per-question Ask AI button rule', () => {
  it('is shown for a split question with no reading (research can answer it) and for a match question with listings', async () => {
    const { none, match } = await world();
    setup(reportOf([none]));
    expect(screen.getByRole('button', { name: /^Ask AI · about \$/ })).toBeVisible();
    cleanup();
    setup(reportOf([match]));
    expect(screen.getByRole('button', { name: /^Ask AI · about \$/ })).toBeVisible();
  });

  it('is not shown where no call would be made: a match question with no listing to choose', async () => {
    const { match } = await world();
    setup(reportOf([{ ...match, candidates: [] }]));
    expect(screen.queryByRole('button', { name: /Ask AI/ })).toBeNull();
  });

  it('says a bundle costs more to ask about than a listing', async () => {
    const { none, match } = await world();
    const opus = state({ ebay: { hasEbayKeys: false, hasAnthropicKey: true, judgeModel: 'claude-opus-5-5', listingsJudgedPerScan: 60 } });
    setup(reportOf([none]), { state: opus });
    expect(screen.getByRole('button', { name: /^Ask AI · / })).toHaveTextContent(researchCostLabel('claude-opus-5-5')!);
    cleanup();
    setup(reportOf([match]), { state: opus });
    expect(screen.getByRole('button', { name: /^Ask AI · / })).toHaveTextContent('about $0.02');
  });
});

describe('the styles of the section', () => {
  const css = readFileSync(join(__dirname, 'AiSuggestions.css'), 'utf8');
  const rule = (sel: string): string => {
    const at = css.indexOf(`${sel} {`);
    expect(at, sel).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };
  it('cuts a row\'s name to one line with an ellipsis and its quote likewise, keeping the source link whole', () => {
    expect(rule('.ai-row-name')).toMatch(/white-space: nowrap/);
    expect(rule('.ai-row-name')).toMatch(/text-overflow: ellipsis/);
    expect(rule('.ai-row-quote-text')).toMatch(/text-overflow: ellipsis/);
    expect(rule('.ai-row-quote .ai-source,\n.ai-row-quote .ai-source-plain')).toMatch(/flex: none/);
  });
  it('uses the tokens only: no colour, shadow or gradient of its own', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(css).not.toMatch(/box-shadow|gradient|border-left/);
  });
  it('lets Accept all and Ask AI about all wrap instead of running past a narrow panel', () => {
    const accept = readFileSync(join(__dirname, 'AcceptSuggested.css'), 'utf8');
    expect(accept.slice(accept.indexOf('.accept-actions {'), accept.indexOf('}', accept.indexOf('.accept-actions {')))).toMatch(/flex-wrap: wrap/);
  });
});
