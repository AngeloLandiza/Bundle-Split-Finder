// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatherEvidence } from '@core/assist/evidence';
import { type StoredSuggestion, suggestionKey } from '@core/assist/stored';
import type { AssistRaw, Suggestion } from '@core/assist/types';
import { verifySuggestion } from '@core/assist/verify';
import { reviewSignature } from '@core/scan/answers';
import type { ReviewItem } from '@core/scan/types';
import { DEFAULT_SETTINGS } from '@core/settings';
import { asked, assistWorld } from '../../../core/test/assist-world';
import type { AppState, PanelReport, Reply, Request } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { ReviewTab } from './ReviewTab';

afterEach(cleanup);

const PSK = 'split:homedepot:339206615';
const PSK_INCLUDES = 'Includes: (1) PBP004 18V ONE+ 4Ah Lithium Batteries, (1) PBP003 18V ONE+ 2Ah Lithium Battery, (1) PCG002 18V ONE+ Charger';
const raw = (a: Partial<AssistRaw>): AssistRaw => ({ evidence: [], reason: 'Because.', decision: 'choose', choiceIndex: null, asin: null, ...a });

/** A real question from the validation replay (with a second reading when asked, so there is a choice to change) and the suggestion the code's check makes of an answer. */
async function question(id = PSK, twoReadings = false): Promise<{ q: ReviewItem; check: (a: Partial<AssistRaw>) => Promise<StoredSuggestion> }> {
  const w = await assistWorld();
  const base = asked(w, id);
  const ev = await gatherEvidence(w.store, base);
  const q = twoReadings ? { ...base, choices: [...base.choices, ['PCG002', 'PBP004']] } : base;
  const check = async (a: Partial<AssistRaw>): Promise<StoredSuggestion> => {
    const checked = verifySuggestion(JSON.stringify(raw(a)), base, ev);
    const suggestion = { questionId: q.id, seen: reviewSignature(q), provider: 'claude', model: 'claude-haiku-5-5', promptVersion: 'v', ...checked } as Suggestion;
    return { key: suggestionKey(q.id, 100), questionId: q.id, seen: reviewSignature(q), askedAt: 100, suggestion, costUsd: 0.0004 };
  };
  return { q, check };
}

const state = (over: Partial<AppState> = {}): AppState => ({
  hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS,
  scanRunning: false, lastJob: null, nextRunAt: null,
  ebay: { hasEbayKeys: false, hasAnthropicKey: true, judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 60 },
  ...over,
});
const reportOf = (review: ReviewItem[], aiSuggestions: StoredSuggestion[] = []) => ({ bundles: [], review, packaging: {}, aiSuggestions }) as unknown as PanelReport;

function setup(report: PanelReport, over: { state?: AppState; answers?: Record<string, Reply> } = {}) {
  const calls: Request[] = [];
  const send = vi.fn(async (r: Request): Promise<Reply> => {
    calls.push(r);
    return over.answers?.[r.type] ?? { ok: true, data: null };
  });
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
  render(createElement(ReviewTab, { api, report, state: over.state ?? state() }));
  return { calls, send };
}

const askButton = () => screen.getByRole('button', { name: /^(Ask AI|Asking)/ });

/**
 * Step 12: a verified suggestion is a row of "AI suggestions", closed. The owner opens it to read the whole suggestion and use the
 * question's controls, which are the same as they were in the list.
 */
const openRow = async (): Promise<void> => {
  await userEvent.click(within(screen.getByRole('region', { name: /AI suggestions/ })).getByRole('button', { expanded: false }));
};

describe('Ask AI: the button', () => {
  it('is absent with no Anthropic key: no disabled teaser', async () => {
    const { q } = await question();
    setup(reportOf([q]), { state: state({ ebay: { hasEbayKeys: false, hasAnthropicKey: false, judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 60 } }) });
    expect(screen.queryByRole('button', { name: /Ask AI/ })).toBeNull();
    cleanup();
    setup(reportOf([q]), { state: state({ ebay: undefined }) });
    expect(screen.queryByRole('button', { name: /Ask AI/ })).toBeNull();
  });

  it('says its price on the button, rounded up, never $0.00', async () => {
    const { q } = await question();
    setup(reportOf([q]));
    expect(askButton()).toHaveAccessibleName('Ask AI · about $0.01');
    expect(askButton()).toHaveTextContent('Ask AI · about $0.01');
    cleanup();
    setup(reportOf([q]), { state: state({ ebay: { hasEbayKeys: false, hasAnthropicKey: true, judgeModel: 'claude-opus-5-5', listingsJudgedPerScan: 60 } }) });
    // Opus, a split question: it is researched, which costs more than reading one listing.
    expect(askButton()).toHaveTextContent('Ask AI · about $0.10');
    expect(document.body.textContent).not.toContain('$0.00');
  });

  it('sits after the answer controls, and the figure is in the figure face', async () => {
    const { q } = await question();
    setup(reportOf([q]));
    const row = askButton().parentElement!;
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Save answer', 'Skip for now', expect.stringContaining('Ask AI')]);
    expect(askButton().querySelector('.figure')).toHaveTextContent('about $0.01');
  });

  it('is not pressable while a scan runs, and says nothing it cannot back', async () => {
    const { q } = await question();
    const { calls } = setup(reportOf([q]), { state: state({ scanRunning: true }) });
    expect(askButton()).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(askButton());
    expect(calls).toEqual([]);
  });
});

describe('Ask AI: asking', () => {
  it('reads Asking… while the call is out, with the question still usable; a suggestion saves nothing', async () => {
    const { q, check } = await question();
    let release!: (r: Reply) => void;
    const held = new Promise<Reply>((r) => (release = r));
    const calls: Request[] = [];
    const api: WorkerApi = {
      send: (async (r: Request) => {
        calls.push(r);
        return r.type === 'askAi' ? held : { ok: true, data: null };
      }) as WorkerApi['send'],
      onStateChanged: () => () => {},
      download: vi.fn(),
    };
    render(createElement(ReviewTab, { api, report: reportOf([q]), state: state() }));
    await userEvent.click(askButton());
    expect(askButton()).toHaveTextContent('Asking…');
    expect(askButton()).not.toHaveTextContent('about');
    expect(calls).toEqual([{ type: 'askAi', questionId: PSK }]);
    // Still usable: a choice can be made while the AI works.
    await userEvent.click(screen.getByRole('radio', { name: 'None of these' }));
    expect(screen.getByRole('radio', { name: 'None of these' })).toBeChecked();
    release({ ok: true, data: await check({ evidence: [{ quote: PSK_INCLUDES, source: 'bundle' }], choiceIndex: 0 }) });
    await screen.findByRole('group', { name: 'AI suggestion' });
    // The owner's own choice is not taken from them, and nothing was saved.
    expect(screen.getByRole('radio', { name: 'None of these' })).toBeChecked();
    expect(calls.map((c) => c.type)).toEqual(['askAi']);
  });

  it('a failed call is one plain line, and the button is back to Ask AI', async () => {
    const { q } = await question();
    setup(reportOf([q]), { answers: { askAi: { ok: true, data: { suggestion: { status: 'not_suggested', reason: 'Claude could not be reached.' } } } } });
    await userEvent.click(askButton());
    expect(await screen.findByText('Claude could not be reached.')).toBeVisible();
    expect(askButton()).toHaveTextContent('Ask AI · about $0.01');
    expect(screen.queryByRole('group', { name: 'AI suggestion' })).toBeNull();
  });

  it('a call that ran out of time says so in words', async () => {
    const { q } = await question();
    const data = { suggestion: { status: 'not_suggested', reason: 'The call to Claude was cancelled.', notSuggested: { reason: 'aborted', message: 'x' } } };
    setup(reportOf([q]), { answers: { askAi: { ok: true, data } } });
    await userEvent.click(askButton());
    expect(await screen.findByText('The AI took too long. Ask again.')).toBeVisible();
  });

  it('a refusal from the worker is said as it is', async () => {
    const { q } = await question();
    setup(reportOf([q]), { answers: { askAi: { ok: false, error: 'That question changed while the AI worked. Ask again.' } } });
    await userEvent.click(askButton());
    expect(await screen.findByText('That question changed while the AI worked. Ask again.')).toBeVisible();
    expect(askButton()).toHaveTextContent('Ask AI');
  });
});

describe('Ask AI: a verified suggestion', () => {
  const RIGHT: Partial<AssistRaw> = { evidence: [{ quote: PSK_INCLUDES, source: 'bundle' }], choiceIndex: 0 };

  it('shows the label, the proposed answer in ink and its quote with a source link in a new tab; the reading is preselected and the button reads Approve', async () => {
    const { q, check } = await question();
    setup(reportOf([q], [await check(RIGHT)]));
    await openRow();
    const block = screen.getByRole('group', { name: 'AI suggestion' });
    expect(within(block).getByText('AI suggestion')).toBeVisible();
    expect(within(block).getByText('PBP004 + PBP003 + PCG002')).toBeVisible();
    expect(within(block).getByText('PBP004 + PBP003 + PCG002')).not.toHaveClass('ai-claimed');
    expect(within(block).getByText(PSK_INCLUDES)).toBeVisible();
    const link = within(block).getByRole('link', { name: 'Home Depot page' });
    expect(link).toHaveAttribute('href', 'https://www.homedepot.com/p/339206615');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByRole('radio', { name: 'PBP004 + PBP003 + PCG002' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Save answer' })).toBeNull();
    // The suggestion is above the answer controls, and Ask AI is gone: it has been asked.
    expect(block.compareDocumentPosition(screen.getByRole('radio', { name: 'None of these' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ask AI/ })).toBeNull();
  });

  it('is the answer only when the owner presses Approve: nothing is sent before', async () => {
    const { q, check } = await question();
    const { calls } = setup(reportOf([q], [await check(RIGHT)]));
    await openRow();
    expect(calls).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(calls).toEqual([{ type: 'answerReview', id: PSK, answer: { choice: 0, seen: reviewSignature(q) }, aiSuggestion: true }]);
  });

  it('changing the selection before Approve sends the other answer, still marked as made with a suggestion on screen', async () => {
    const { q, check } = await question(PSK, true);
    const { calls } = setup(reportOf([q], [await check(RIGHT)]));
    await openRow();
    expect(screen.getByRole('radio', { name: 'PBP004 + PBP003 + PCG002' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'PCG002 + PBP004' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(calls).toEqual([{ type: 'answerReview', id: PSK, answer: { choice: 1, seen: reviewSignature(q) }, aiSuggestion: true }]);
  });

  it('the button reads Approve only while the selection is the AI\'s answer; any other selection reads Save answer', async () => {
    const { q, check } = await question(PSK, true);
    setup(reportOf([q], [await check(RIGHT)]));
    await openRow();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    await userEvent.click(screen.getByRole('radio', { name: 'PCG002 + PBP004' }));
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeEnabled();
    await userEvent.click(screen.getByRole('radio', { name: 'None of these' }));
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeEnabled();
    await userEvent.click(screen.getByRole('radio', { name: 'PBP004 + PBP003 + PCG002' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('a suggestion that arrives from asking takes focus, since the button pressed is gone', async () => {
    const { q, check } = await question();
    setup(reportOf([q]), { answers: { askAi: { ok: true, data: await check(RIGHT) } } });
    await userEvent.click(askButton());
    const block = await screen.findByRole('group', { name: 'AI suggestion' });
    await waitFor(() => expect(block).toHaveFocus());
    expect(screen.getByRole('radio', { name: 'PBP004 + PBP003 + PCG002' })).toBeChecked();
  });

  it('shows at most three quotes', async () => {
    const { q, check } = await question();
    const s = await check(RIGHT);
    const many = { ...s, suggestion: { ...s.suggestion, quotes: Array.from({ length: 5 }, (_, i) => ({ quote: `line ${i}`, sourceId: 'bundle', label: 'Home Depot page', url: 'https://www.homedepot.com/p/1', names: false })) } } as StoredSuggestion;
    setup(reportOf([q], [many]));
    await openRow();
    expect(within(screen.getByRole('group', { name: 'AI suggestion' })).getAllByRole('link')).toHaveLength(3);
  });

  it('links only to http or https: any other address is shown as text', async () => {
    const { q, check } = await question();
    const s = await check(RIGHT);
    const bad = { ...s, suggestion: { ...s.suggestion, quotes: [{ quote: 'a line', sourceId: 'bundle', label: 'Home Depot page', url: 'javascript:alert(1)', names: true }] } } as StoredSuggestion;
    setup(reportOf([q], [bad]));
    // Not a link in the row either.
    expect(within(screen.getByRole('region', { name: /AI suggestions/ })).queryByRole('link')).toBeNull();
    await openRow();
    const block = screen.getByRole('group', { name: 'AI suggestion' });
    expect(within(block).queryByRole('link')).toBeNull();
    expect(within(block).getByText('Home Depot page')).toBeVisible();
  });

  it('a match question preselects the listing the AI named, and shows its title and ASIN', async () => {
    const w = await assistWorld();
    const q = asked(w, 'match:RYOBI:P553');
    const c = q.candidates[2]!;
    const s: StoredSuggestion = {
      key: suggestionKey(q.id, 1), questionId: q.id, seen: reviewSignature(q), askedAt: 1, costUsd: null,
      suggestion: { questionId: q.id, seen: reviewSignature(q), provider: 'claude', model: 'm', promptVersion: 'v', status: 'verified', reason: 'r', quotes: [], answer: { decision: 'choose', kind: 'match', asin: c.asin, title: c.title } },
    };
    setup(reportOf([q], [s]));
    await openRow();
    const block = screen.getByRole('group', { name: 'AI suggestion' });
    expect(within(block).getByText(c.asin)).toBeVisible();
    expect(screen.getAllByRole('radio')[2]).toBeChecked();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });
});

describe('Ask AI: the states that preselect nothing', () => {
  it('unverified: labelled so, shows what it claimed and why the code could not confirm it, preselects nothing, and the button stays Save answer', async () => {
    const { q, check } = await question();
    const { calls } = setup(reportOf([q], [await check({ evidence: [{ quote: 'a line the page does not have', source: 'bundle' }], choiceIndex: 0 })]));
    const block = screen.getByRole('group', { name: 'AI suggestion' });
    expect(within(block).getByText('AI suggestion, unverified')).toBeVisible();
    expect(within(block).getByText('PBP004 + PBP003 + PCG002')).toBeVisible();
    // Only a verified answer is in ink: what the code could not confirm is in ink-2.
    expect(within(block).getByText('PBP004 + PBP003 + PCG002')).toHaveClass('ai-claimed');
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('cannot tell: says so with its one-line reason, preselects nothing', async () => {
    const { q, check } = await question();
    setup(reportOf([q], [await check({ decision: 'cannot_tell', reason: 'The page does not list the parts.' })]));
    const block = screen.getByRole('group', { name: 'AI suggestion' });
    expect(within(block).getByText('AI could not tell from the page')).toBeVisible();
    expect(within(block).getByText('The page does not list the parts.')).toBeVisible();
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeDisabled();
  });

  it('none of these fits: the AI\'s view with its reason and no quotes (the code cannot tell which back the reason), nothing preselected, Save answer not Approve', async () => {
    const { q, check } = await question();
    const { calls } = setup(reportOf([q], [await check({ decision: 'none', reason: 'The page lists other parts.', evidence: [{ quote: PSK_INCLUDES, source: 'bundle' }] })]));
    const block = screen.getByRole('group', { name: 'AI suggestion' });
    expect(within(block).getByText('AI suggests none of these fits')).toBeVisible();
    expect(within(block).getByText('The page lists other parts.')).toBeVisible();
    // A quote that is found does not show that nothing fits: none are shown with it.
    expect(within(block).queryByText(PSK_INCLUDES)).toBeNull();
    expect(within(block).queryByRole('link')).toBeNull();
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    // The owner answers as before; the answer is still marked as made with a suggestion on screen.
    await userEvent.click(screen.getByRole('radio', { name: 'None of these' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(calls).toEqual([{ type: 'answerReview', id: PSK, answer: { none: true, seen: reviewSignature(q) }, aiSuggestion: true }]);
  });
});

describe('Ask AI: a suggestion for another question is not shown', () => {
  it('one made for choices the question no longer has is dropped by the panel, whatever the report holds', async () => {
    const { q, check } = await question();
    const s = await check({ evidence: [{ quote: PSK_INCLUDES, source: 'bundle' }], choiceIndex: 0 });
    setup(reportOf([q], [{ ...s, seen: JSON.stringify([['OTHER']]) }]));
    expect(screen.queryByRole('group', { name: 'AI suggestion' })).toBeNull();
    expect(askButton()).toBeVisible();
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked();
  });
});

describe('Accept all leaves out a question the AI has spoken on', () => {
  const ONE = 'The model number reads as one reading.';
  async function threeSingleReadings() {
    const w = await assistWorld();
    // Questions that offer one reading each and whose reading did not come from the page: the ones Accept all answers.
    const a = { ...asked(w, 'split:homedepot:339206615'), reason: ONE };
    const b = { ...asked(w, 'split:homedepot:320243741'), reason: ONE, openedAt: 5 };
    const c = { ...asked(w, 'split:homedepot:341644756'), reason: ONE, openedAt: 6 };
    const ev = await gatherEvidence(w.store, a);
    const checked = verifySuggestion(JSON.stringify(raw({ decision: 'none', reason: 'None.', evidence: [{ quote: PSK_INCLUDES, source: 'bundle' }] })), a, ev);
    expect(checked.status).toBe('none_suggested');
    const none: StoredSuggestion = { key: suggestionKey(a.id, 1), questionId: a.id, seen: reviewSignature(a), askedAt: 1, costUsd: null, suggestion: { questionId: a.id, seen: reviewSignature(a), provider: 'claude', model: 'm', promptVersion: 'v', ...checked } as Suggestion };
    return { a, b, c, none };
  }

  it('answers the others as it always did, with no mark of a suggestion, and never the question with a live suggestion', async () => {
    const { a, b, c, none } = await threeSingleReadings();
    const { calls } = setup(reportOf([a, b, c], [none]));
    await userEvent.click(screen.getByRole('button', { name: 'Accept all 2' }));
    await waitFor(() => expect(calls.filter((x) => x.type === 'answerReview')).toHaveLength(2));
    expect(calls.map((x) => (x as { id: string }).id).sort()).toEqual([b.id, c.id].sort());
    for (const x of calls) {
      expect(x).not.toHaveProperty('aiSuggestion');
      expect(x).toMatchObject({ answer: { choice: 0 } });
    }
  });

  it('offers no Accept all when only one question is left without a suggestion', async () => {
    const { a, b, none } = await threeSingleReadings();
    setup(reportOf([a, b], [none]));
    expect(screen.queryByRole('button', { name: /^Accept all/ })).toBeNull();
  });

  it('a suggestion for other choices does not keep a question out of Accept all', async () => {
    const { a, b, c, none } = await threeSingleReadings();
    setup(reportOf([a, b, c], [{ ...none, seen: JSON.stringify([['OTHER']]) }]));
    expect(screen.getByRole('button', { name: 'Accept all 3' })).toBeVisible();
  });
});

describe('the Ask AI styles', () => {
  const css = readFileSync(join(__dirname, 'AiSuggestion.css'), 'utf8');
  const rule = (sel: string): string => {
    const at = css.indexOf(`${sel} {`);
    expect(at).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };
  it('keeps the cost on the same line as Ask AI, gives a source link a tap target, and sets a claim in ink-2', () => {
    expect(rule('.btn.ai-ask')).toContain('white-space: nowrap');
    expect(rule('.ai-source')).toMatch(/padding: 4px 0/);
    expect(rule('.ai-claimed')).toContain('color: var(--ink-2)');
  });
  it('sets the block 12px under what is above it (8px gap and 4px more)', () => {
    expect(rule('.review-question > .ai-block')).toContain('margin-top: 4px');
  });
});
