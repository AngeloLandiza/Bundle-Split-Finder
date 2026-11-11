// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScanJob } from '@core/scan/types';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { AppState, Reply, Request } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { FirstRun } from './FirstRun';
import { noticeSentence, Notice } from './Notice';
import { sentenceFor } from '../../lib/sentences';
import { parseAccount, SearchBudget } from '@core/serpapi/budget';
import { MemoryCache, NETWORK_ERROR_PREFIX, SerpApiClient } from '@core/serpapi/client';
import * as fx from '../../../core/test/fixtures';

afterEach(cleanup);

const state = (over: Partial<AppState> = {}): AppState => ({
  hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS,
  scanRunning: false, lastJob: null, nextRunAt: null, ...over,
});

const job = (over: Partial<ScanJob>): ScanJob => ({ status: 'stopped', stopReason: 'error', stopMessage: 'The listing search failed.', ...over }) as ScanJob;

function makeApi(reply: Reply | Promise<Reply> = { ok: true, data: null }) {
  const send = vi.fn(async (_r: Request): Promise<Reply> => reply);
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
  return { api, send };
}

describe('fix round: Notice', () => {
  const OFFLINE = 'SerpApi could not be reached. Check the connection, then retry.';
  const network = `${NETWORK_ERROR_PREFIX}: Failed to fetch`;

  it('maps a network failure to the offline sentence from every source', () => {
    expect(sentenceFor(network)).toBe(OFFLINE);
    expect(noticeSentence(state(), network)).toBe(OFFLINE);
    expect(noticeSentence(state({ problem: network }), null)).toBe(OFFLINE);
    expect(noticeSentence(state({ lastJob: job({ stopMessage: network }) }), null)).toBe(OFFLINE);
    expect(sentenceFor('Something else.')).toBe('Something else.');
  });

  it('shows nothing above the tabs for a scan the owner stopped, even when it keeps an earlier failure\'s text', () => {
    const s = state({ lastJob: job({ stopReason: 'user', stopMessage: 'SerpApi returned HTTP 404.' }) });
    expect(noticeSentence(s, null)).toBeNull();
    const view = render(createElement(Notice, { state: s, api: makeApi().api, error: null }));
    expect(view.container).toBeEmptyDOMElement();
  });

  it('maps the message the client itself throws', async () => {
    const client = new SerpApiClient({
      apiKey: 'K',
      budget: new SearchBudget(parseAccount(fx.SERPAPI_ACCOUNT_FREE), { reserve: 0, maxPerRun: 5 }),
      cache: new MemoryCache(),
      fetchFn: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });
    const err = await client.search({ engine: 'home_depot', q: 'x' }).catch((e: Error) => e);
    expect((err as Error).message.startsWith(NETWORK_ERROR_PREFIX)).toBe(true);
    expect(sentenceFor((err as Error).message)).toBe(OFFLINE);
  });

  it('says an HTTP error from SerpApi in words, from the message the client itself throws', async () => {
    const client = new SerpApiClient({
      apiKey: 'K',
      budget: new SearchBudget(parseAccount(fx.SERPAPI_ACCOUNT_FREE), { reserve: 0, maxPerRun: 5 }),
      cache: new MemoryCache(),
      fetchFn: (async () => new Response('{}', { status: 503 })) as typeof fetch,
    });
    const err = await client.search({ engine: 'home_depot', q: 'x' }).catch((e: Error) => e);
    const words = 'SerpApi answered with an error (HTTP 503). Try again later.';
    expect(sentenceFor((err as Error).message)).toBe(words);
    expect(noticeSentence(state({ lastJob: job({ stopMessage: (err as Error).message }) }), null)).toBe(words);
    // A key SerpApi refused already says so in words.
    const refused = await new SerpApiClient({
      apiKey: 'K',
      budget: new SearchBudget(parseAccount(fx.SERPAPI_ACCOUNT_FREE), { reserve: 0, maxPerRun: 5 }),
      fetchFn: (async () => new Response('{}', { status: 401 })) as typeof fetch,
    })
      .search({ engine: 'home_depot', q: 'x' })
      .catch((e: Error) => e);
    expect(sentenceFor((refused as Error).message)).toBe('SerpApi did not accept this key.');
  });

  it('shows the offline sentence for a refused retry too', async () => {
    const api = makeApi({ ok: false, error: network });
    render(createElement(Notice, { state: state({ problem: 'Bad.' }), api: api.api, error: null }));
    await userEvent.setup().click(screen.getByRole('button', { name: /^Retry/ }));
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });

  it('drops a refused retry sentence when the state changes', async () => {
    const api = makeApi({ ok: false, error: 'A scan is already running.' });
    const view = render(createElement(Notice, { state: state({ problem: 'Bad.' }), api: api.api, error: null }));
    await userEvent.setup().click(screen.getByRole('button', { name: /^Retry/ }));
    expect(await screen.findByText('A scan is already running.')).toBeInTheDocument();
    view.rerender(createElement(Notice, { state: state({ problem: 'Worse.' }), api: api.api, error: null }));
    expect(screen.queryByText('A scan is already running.')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Worse.');
  });

  it('disables Retry with the hourly title while the hourly limit blocks scans', () => {
    const finishedAt = 1_000_000;
    const s = state({ problem: 'Bad.', lastJob: job({ stopReason: 'hourly_limit', finishedAt }) });
    render(createElement(Notice, { state: s, api: makeApi().api, error: null, now: () => finishedAt + 60_000 }));
    const retry = screen.getByRole('button', { name: /^Retry/ });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute('title', expect.stringMatching(/^The hourly search limit is reached\. Try again after/));
    // The reason is on screen as text, not only in the title.
    expect(screen.getByText(/^The hourly search limit is reached\. Try again after/)).toBeInTheDocument();
  });

  it('moves focus to the scan control when the scan starts and the whole notice unmounts', async () => {
    const api = makeApi();
    const s = state({ problem: 'Bad.' });
    const tree = (st: AppState) => createElement('div', null, createElement('button', { id: 'scan-control' }, 'Scan now'), createElement(Notice, { state: st, api: api.api, error: null }));
    const view = render(tree(s));
    await userEvent.setup().click(screen.getByRole('button', { name: /^Retry/ }));
    await vi.waitFor(() => expect(api.send).toHaveBeenCalled());
    view.rerender(tree({ ...s, problem: null, scanRunning: true }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Scan now' })).toHaveFocus();
  });

  it('keeps focus where it is when a scan starts that Retry did not start', () => {
    const api = makeApi();
    const s = state({ problem: 'Bad.' });
    const tree = (st: AppState) => createElement('div', null, createElement('button', { id: 'scan-control' }, 'Scan now'), createElement(Notice, { state: st, api: api.api, error: null }));
    const view = render(tree(s));
    view.rerender(tree({ ...s, scanRunning: true }));
    expect(screen.getByRole('button', { name: 'Scan now' })).not.toHaveFocus();
  });

  it('puts the cost in its own span', () => {
    render(createElement(Notice, { state: state({ problem: 'Bad.' }), api: makeApi().api, error: null }));
    expect(screen.getByText('up to 5 searches')).toHaveClass('notice-cost');
  });
});

describe('fix round: FirstRun', () => {
  const show = (settings: Partial<typeof DEFAULT_SETTINGS>) =>
    render(createElement(FirstRun, { state: state({ hasKey: false, settings: { ...DEFAULT_SETTINGS, ...settings } }), api: makeApi().api, openSettings: () => {} }));

  it('says the schedule from settings', () => {
    show({ schedule: { mode: 'interval', hours: 6 } });
    expect(screen.getByText('Starts with DEWALT and RYOBI, scanning every 6 hours.')).toBeInTheDocument();
  });

  it('handles no brands without a double space', () => {
    show({ brands: [] });
    expect(screen.getByText('Starts with no brands yet.')).toBeInTheDocument();
    expect(screen.getByText(/checks Home Depot for bundles, matches/)).toBeInTheDocument();
  });

  it('marks the current step', () => {
    show({});
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('aria-current'))).toEqual(['step', null, null]);
  });
});

describe('FirstRun', () => {
  it('shows the intro, three steps and the free-path note, with brands from settings', () => {
    const { api } = makeApi();
    render(createElement(FirstRun, { state: state({ hasKey: false, settings: { ...DEFAULT_SETTINGS, brands: ['RYOBI'] } }), api, openSettings: () => {} }));
    expect(screen.getByRole('heading', { name: 'Find bundles worth splitting' })).toBeInTheDocument();
    expect(screen.getByText(/checks Home Depot for RYOBI bundles/)).toBeInTheDocument();
    expect(screen.getByText('Starts with RYOBI, scanning only when you click.')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(
      screen.getByText('Searches find bundles on Home Depot and parts on Amazon. Each bundle\'s own page is read in your browser, free.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/reads the page you are on/)).toBeNull();
  });

  it('Open settings calls openSettings; Get a free key is a real new-tab link', async () => {
    const { api } = makeApi();
    const openSettings = vi.fn();
    render(createElement(FirstRun, { state: state({ hasKey: false }), api, openSettings }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open settings' }));
    expect(openSettings).toHaveBeenCalledTimes(1);
    const link = screen.getByRole('link', { name: 'Get a free key' });
    expect(link).toHaveAttribute('href', 'https://serpapi.com/users/sign_up');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('sends nothing, even when every control is used', async () => {
    const { api, send } = makeApi();
    render(createElement(FirstRun, { state: state({ hasKey: false }), api, openSettings: () => {} }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open settings' }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /search/i })).toBeNull();
  });
});

describe('Notice', () => {
  const show = (s: AppState, error: string | null = null, api = makeApi()) => {
    render(createElement(Notice, { state: s, api: api.api, error }));
    return api;
  };

  it('shows nothing when there is nothing to say', () => {
    show(state());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('prefers the error prop, then problem, then the last scan error', () => {
    const s = state({ problem: 'Account problem.', lastJob: job({}) });
    show(s, 'Refused.');
    expect(screen.getByRole('alert')).toHaveTextContent('Refused.');
    cleanup();
    show(s);
    expect(screen.getByRole('alert')).toHaveTextContent('Account problem.');
    cleanup();
    show(state({ lastJob: job({ stopReason: 'rate_limited', stopMessage: 'SerpApi refused the search.' }) }));
    expect(screen.getByRole('alert')).toHaveTextContent('SerpApi refused the search.');
    cleanup();
    show(state({ lastJob: job({}) }));
    expect(screen.getByRole('alert')).toHaveTextContent('The listing search failed.');
  });

  it('leaves limit stops and finished scans to other notices', () => {
    for (const stopReason of ['run_cap', 'reserve', 'hourly_limit'] as const) {
      show(state({ lastJob: job({ stopReason, stopMessage: 'Stopped.' }) }));
      expect(screen.queryByRole('alert')).toBeNull();
      cleanup();
    }
    show(state({ lastJob: job({ status: 'done', stopReason: null, stopMessage: 'Note.' }) }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the offline sentence in place of the worker text', () => {
    show(state({ problem: 'Network error reaching SerpApi: Failed to fetch' }));
    expect(screen.getByRole('alert')).toHaveTextContent('SerpApi could not be reached. Check the connection, then retry.');
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
  });

  it('Retry shows its cost, sends scanNow once, and waits for the reply', async () => {
    let answer!: (r: Reply) => void;
    const pending = new Promise<Reply>((ok) => (answer = ok));
    const { send } = show(state({ problem: 'Bad.', settings: { ...DEFAULT_SETTINGS, searchesPerScan: 8 } }), null, makeApi(pending));
    const retry = screen.getByRole('button', { name: 'Retry up to 8 searches' });
    const user = userEvent.setup();
    await user.click(retry);
    expect(retry).toBeDisabled();
    await user.click(retry);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'scanNow' });
    answer({ ok: true, data: null });
    await vi.waitFor(() => expect(retry).toBeEnabled());
  });

  it('says one search in the singular', () => {
    show(state({ problem: 'Bad.', settings: { ...DEFAULT_SETTINGS, searchesPerScan: 1 } }));
    expect(screen.getByRole('button', { name: 'Retry up to 1 search' })).toBeInTheDocument();
  });

  it('shows a refused retry in place of the old sentence', async () => {
    show(state({ problem: 'Bad.' }), null, makeApi({ ok: false, error: 'A scan is already running.' }));
    await userEvent.setup().click(screen.getByRole('button', { name: /^Retry/ }));
    expect(await screen.findByText('A scan is already running.')).toBeInTheDocument();
  });

  it('shows UNREACHABLE when the retry cannot be delivered', async () => {
    const send = vi.fn(async () => {
      throw new Error('gone');
    });
    const api = { send, onStateChanged: () => () => {}, download: vi.fn() } as unknown as WorkerApi;
    render(createElement(Notice, { state: state({ problem: 'Bad.' }), api, error: null }));
    await userEvent.setup().click(screen.getByRole('button', { name: /^Retry/ }));
    expect(await screen.findByText(UNREACHABLE)).toBeInTheDocument();
  });

  it('hides Retry during a scan and when there is no key, keeping the sentence', () => {
    show(state({ problem: 'Bad.', scanRunning: true }));
    expect(screen.getByRole('alert')).toHaveTextContent('Bad.');
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    show(state({ problem: 'Bad.', hasKey: false }));
    expect(screen.queryByRole('button')).toBeNull();
  });
});
