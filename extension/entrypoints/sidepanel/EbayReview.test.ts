// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { EbayQuestion as Question, ReviewItem } from '@core/scan/types';
import type { AppState, PanelReport, Reply, Request } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { ReviewTab } from './ReviewTab';

// Step 10: the owner's question about an eBay listing the judge left unsure. The listing is DEWALT DCF921B's
// 920101779170 as recorded: the item specifics name DCF911B as well, which the check reads as a different model.

afterEach(cleanup);

const Q: Question = {
  id: 'DEWALT:DCF921B|v1|920101779170|0', key: 'DEWALT:DCF921B', brand: 'DEWALT', model: 'DCF921B', itemId: 'v1|920101779170|0',
  title: 'DEWALT DCF921B 20V MAX Brushless 1/2" Cordless Impact Wrench Tool Only', url: 'https://www.ebay.com/itm/920101779170', price: 79, soldQuantity: 4,
  reasons: ['The listing details name DCF911B, a different model.', 'The title names the model but not what is included.'], openedAt: 5,
};
const SPLIT: ReviewItem = {
  id: 'split:a', kind: 'split', subject: 'homedepot:1', brand: 'DEWALT', model: 'DCK240C2', title: 'DEWALT 20V MAX Cordless 2 Tool Combo Kit', reason: 'The kit lists two impact wrenches.',
  candidates: [], choices: [['DCF891B', 'DCB205']], openedAt: 9, answer: null, answeredAt: null,
};

const state = (over: Partial<AppState> = {}): AppState => ({
  hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS, scanRunning: false, lastJob: null, nextRunAt: null, ...over,
});
const report = (ebayQuestions: Question[], review: ReviewItem[] = []) => ({ bundles: [], review, ebayQuestions, packaging: {} }) as unknown as PanelReport;

function setup(r: PanelReport | null, reply: Reply = { ok: true, data: null }, st: AppState = state()) {
  const send = vi.fn(async (_r: Request): Promise<Reply> => reply);
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
  render(createElement(ReviewTab, { api, report: r, state: st }));
  return { send };
}

const save = () => screen.getByRole('button', { name: 'Save answer' });

describe('Review: an eBay listing question', () => {
  it('asks "Is this eBay listing exactly <MODEL>, New, with the same contents?", with the listing, why the check was unsure, and a link', () => {
    setup(report([Q]));
    const legend = screen.getByText(/Is this eBay listing exactly/, { selector: 'legend' });
    expect(legend).toHaveTextContent('Is this eBay listing exactly DCF921B, New, with the same contents?');
    expect(screen.getByRole('group', { name: 'Is this eBay listing exactly DCF921B, New, with the same contents?' }).tagName).toBe('FIELDSET');
    expect(screen.getByText(Q.title)).toBeInTheDocument();
    expect(screen.getByText('$79.00')).toHaveClass('figure');
    expect(screen.getByText('4 sold')).toBeInTheDocument();
    expect(screen.getByText('Why the check was not certain')).toBeInTheDocument();
    for (const reason of Q.reasons) expect(screen.getByText(reason)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open this listing on eBay' });
    expect(link).toHaveAttribute('href', Q.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual(['Yes, it is exactly this part', 'No, it is not']);
    expect(screen.getByText(/never counted in an estimate/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('draws no link for an address that is not http or https', () => {
    setup(report([{ ...Q, url: 'javascript:alert(1)' }]));
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    setup(report([{ ...Q, url: '' }]));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('Yes sends answerEbay with the part, the listing and yes, then moves on', async () => {
    const user = userEvent.setup();
    const { send } = setup(report([Q]));
    await user.click(screen.getByRole('radio', { name: 'Yes, it is exactly this part' }));
    await user.click(save());
    expect(send).toHaveBeenCalledWith({ type: 'answerEbay', key: 'DEWALT:DCF921B', itemId: 'v1|920101779170|0', answer: 'yes' });
    expect(await screen.findByText('Nothing needs your answer.')).toBeInTheDocument();
  });

  it('No sends no', async () => {
    const user = userEvent.setup();
    const { send } = setup(report([Q]));
    await user.click(screen.getByRole('radio', { name: 'No, it is not' }));
    await user.click(save());
    expect(send).toHaveBeenCalledWith({ type: 'answerEbay', key: 'DEWALT:DCF921B', itemId: 'v1|920101779170|0', answer: 'no' });
  });

  it('shows the worker\'s refusal and keeps the question', async () => {
    const user = userEvent.setup();
    setup(report([Q]), { ok: false, error: 'That question changed. Choose again.' });
    await user.click(screen.getByRole('radio', { name: 'No, it is not' }));
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('That question changed. Choose again.');
    // The choice is cleared when the question changed, so a stale answer is not sent again.
    await waitFor(() => expect(screen.getByRole('radio', { name: 'No, it is not' })).not.toBeChecked());
    expect(save()).toBeDisabled();
  });

  it('says so when the extension cannot be reached', async () => {
    const user = userEvent.setup();
    const send = vi.fn(async () => {
      throw new Error('gone');
    });
    const api: WorkerApi = { send: send as unknown as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    render(createElement(ReviewTab, { api, report: report([Q]), state: state() }));
    await user.click(screen.getByRole('radio', { name: 'Yes, it is exactly this part' }));
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent(UNREACHABLE);
  });

  it('cannot be saved while a scan runs, and says why', () => {
    setup(report([Q]), undefined, state({ scanRunning: true }));
    expect(save()).toBeDisabled();
    expect(screen.getByText('A scan is running. Answer when it has finished.')).toBeInTheDocument();
  });

  it('is one of the questions in turn: oldest first among review items, counted with them, and Skip for now puts it back', async () => {
    const user = userEvent.setup();
    setup(report([Q], [SPLIT]));
    // The eBay question is older (5) than the split question (9).
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByText(/Is this eBay listing exactly/, { selector: 'legend' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.getByText('Which parts come in this bundle?', { selector: 'legend' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.getByText(/Is this eBay listing exactly/, { selector: 'legend' })).toBeInTheDocument();
  });

  it('an eBay question alone is not offered Accept all, and a report from before step 10 (no list) still reads', () => {
    setup({ bundles: [], review: [SPLIT], packaging: {} } as unknown as PanelReport);
    expect(screen.getByText('Which parts come in this bundle?', { selector: 'legend' })).toBeInTheDocument();
    cleanup();
    setup(report([Q]));
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
  });
});
