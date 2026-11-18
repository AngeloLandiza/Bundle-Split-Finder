// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Chip, COULD_NOT_OPEN } from './Chip';
import { chipModel, type ChipModel } from './chipModel';
import type { BundleView } from '../../lib/messages';
import { estimateView, lookupView, noReadingView, oneReadingView } from './realViews';

afterEach(cleanup);

// The views are the real notePage's, over the recorded 328814689 and 328690510 pages and the recorded scan.
const views: Record<string, BundleView> = {};
beforeAll(async () => {
  views.estimate = await estimateView();
  views.lookup = await lookupView();
  views.one = await oneReadingView();
  views.none = await noReadingView();
}, 60_000);

const show = (model: ChipModel, open = async () => true) => render(createElement(Chip, { model, open }));

describe('chipModel: what each real PageView says', () => {
  it('after the recorded scan: the estimate, labelled, with the ROI', () => {
    // The founder's bundle after the scan: $79.55 on a $189 cost (page-view.test.ts), 42% ROI.
    expect(chipModel(views.estimate!)).toEqual({ kind: 'estimate', parts: 2, profit: '+$79.55', roi: '42%', loss: false });
  });

  it('with no listing saved: the lookup it would take, in searches', () => {
    expect(chipModel(views.lookup!)).toEqual({ kind: 'lookup', parts: 2, searches: 2 });
  });

  it('one reading offered: its size and the need for an answer', () => {
    expect(chipModel(views.one!)).toEqual({ kind: 'question', parts: 2 });
  });

  it('no reading offered: no part count', () => {
    expect(chipModel(views.none!)).toEqual({ kind: 'question', parts: null });
  });

  it('a question wins over a stale estimate, and the owner having said none of them fits gives no chip', () => {
    // Hand-made from the real views: the shapes the contract names that no recorded page produces.
    const estimate = views.estimate!;
    expect(chipModel({ ...estimate, question: views.one!.question })).toEqual({ kind: 'question', parts: 2 });
    expect(chipModel({ ...estimate, parts: 0 })).toBeNull();
  });

  it('several readings: no part count; parts known with nothing waiting and no estimate: no figures', () => {
    const q = views.one!.question!;
    expect(chipModel({ ...views.one!, question: { ...q, choices: [['A', 'B'], ['C']] } })).toEqual({ kind: 'question', parts: null });
    expect(chipModel({ ...views.lookup!, lookupParts: 0 })).toEqual({ kind: 'plain', parts: 2 });
  });

  it('a loss reads with a real minus and is marked as one', () => {
    const e = views.estimate!;
    const loss = chipModel({ ...e, row: { ...e.row, estimate: { ...e.row.estimate!, profit: -12.4, roi: -0.06 } } });
    expect(loss).toEqual({ kind: 'estimate', parts: 2, profit: '−$12.40', roi: '−6%', loss: true });
  });

  it('one part and one search are singular', () => {
    expect(chipModel({ ...views.lookup!, parts: 1, lookupParts: 1 })).toEqual({ kind: 'lookup', parts: 1, searches: 1 });
  });
});

describe('the chip, one variant per state', () => {
  it('estimate: one button with the parts, the estimated profit, the ROI and a chevron', () => {
    show(chipModel(views.estimate!)!);
    const chip = screen.getByRole('button', { name: 'Splits into 2 parts Est. profit +$79.55 ROI 42%' });
    expect(chip).toHaveClass('chip');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(chip.querySelectorAll('svg')).toHaveLength(2);
    expect(screen.getByText('Est. profit')).toBeInTheDocument();
  });

  it('a loss is coloured as one, the ROI with it (as Deals rows do)', () => {
    show({ kind: 'estimate', parts: 2, profit: '−$12.40', roi: '−6%', loss: true });
    expect(screen.getByText('−$12.40')).toHaveClass('chip-profit--loss');
    expect(screen.getByText('ROI −6%')).toHaveClass('chip-roi--loss');
  });

  it('a gain leaves the ROI in the quiet colour', () => {
    show({ kind: 'estimate', parts: 2, profit: '+$79.55', roi: '42%', loss: false });
    expect(screen.getByText('ROI 42%')).not.toHaveClass('chip-roi--loss');
  });

  it('unknown prices: look up prices, with the searches it would take', () => {
    show(chipModel(views.lookup!)!);
    expect(screen.getByRole('button', { name: 'Splits into 2 parts · Look up prices · 2 searches' })).toBeInTheDocument();
  });

  it('1 search is singular', () => {
    show({ kind: 'lookup', parts: 2, searches: 1 });
    expect(screen.getByRole('button', { name: 'Splits into 2 parts · Look up prices · 1 search' })).toBeInTheDocument();
  });

  it('needs an answer, one reading', () => {
    show(chipModel(views.one!)!);
    expect(screen.getByRole('button', { name: 'Splits into 2 parts · needs your answer' })).toBeInTheDocument();
  });

  it('needs an answer, no single reading', () => {
    show(chipModel(views.none!)!);
    expect(screen.getByRole('button', { name: 'Which parts? · needs your answer' })).toBeInTheDocument();
  });

  it('parts known and nothing to show beside them', () => {
    show({ kind: 'plain', parts: 2 });
    expect(screen.getByRole('button', { name: 'Splits into 2 parts' })).toBeInTheDocument();
  });

  it('says "part", never "item" or "component"', () => {
    for (const model of [views.estimate!, views.lookup!, views.one!, views.none!].map((v) => chipModel(v)!)) {
      const { container, unmount } = show(model);
      expect(container.textContent).not.toMatch(/\bitems?\b|component/i);
      unmount();
    }
  });
});

describe('clicking the chip', () => {
  it('asks the worker to open the panel and says nothing when it opened', async () => {
    const open = vi.fn(async () => true);
    show({ kind: 'plain', parts: 2 }, open);
    await userEvent.click(screen.getByRole('button'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('says in one sentence, inside the chip, when the panel could not be opened: still one 40px button, nothing added below', async () => {
    const { container } = show({ kind: 'plain', parts: 2 }, async () => false);
    await userEvent.click(screen.getByRole('button'));
    const button = await screen.findByRole('button', { name: COULD_NOT_OPEN });
    expect(COULD_NOT_OPEN).toBe('Open Split Finder from the toolbar to see this bundle.');
    // The chip's content is replaced by the sentence: no other words, and the same single control.
    expect(button).toHaveTextContent(/^Open Split Finder from the toolbar to see this bundle\.$/);
    expect(button).not.toHaveTextContent('Splits into');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    // The announcement region is always there; it holds the sentence and takes no room of its own.
    expect(screen.getByRole('status')).toHaveTextContent(COULD_NOT_OPEN);
    expect(screen.getByRole('status')).toHaveClass('chip-status');
    expect(container.querySelectorAll('.chip-wrap > *')).toHaveLength(2);
  });

  it('the announcement region is rendered from the start, empty', () => {
    show({ kind: 'plain', parts: 2 });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('says the same when the worker does not answer', async () => {
    show({ kind: 'plain', parts: 2 }, () => Promise.reject(new Error('Extension context invalidated.')));
    await userEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(COULD_NOT_OPEN));
    expect(screen.getByRole('button', { name: COULD_NOT_OPEN })).toBeInTheDocument();
  });

  it('clears the sentence when the next click opens the panel, and ignores a click while one is pending', async () => {
    let answer = false;
    let release: () => void = () => {};
    const open = vi.fn(() => new Promise<boolean>((ok) => (release = () => ok(answer))));
    show({ kind: 'plain', parts: 2 }, open);
    const button = screen.getByRole('button');
    await userEvent.click(button);
    await userEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(COULD_NOT_OPEN));
    answer = true;
    await userEvent.click(button);
    release();
    await waitFor(() => expect(screen.getByRole('status')).toBeEmptyDOMElement());
    expect(screen.getByRole('button', { name: 'Splits into 2 parts' })).toBeInTheDocument();
  });
});
