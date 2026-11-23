// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DealDetail, DealRow, DealsResponse, ReviewQuestion, ReviewResponse } from '@core/api/contract';
import type { ReviewItem } from '@core/scan/types';
import type { AgentApi, AgentReply } from '../../lib/agentApi';
import { DEFAULT_SETTINGS } from '@core/settings';
import { NOTICE_REVOKED, NOTICE_UNREACHABLE, UNPAIRED, type AgentLink, type LinkStore } from '../../lib/agentLink';
import type { WorkerApi } from '../../lib/pageClient';
import type { AgentLinkActions } from '../../lib/useAgentLink';
import { App } from './App';
import { HelperPanel, NOT_IN_APP, NO_PAGE, OPEN_APP_TEXT, apiAnswer, homeDepotItemId } from './HelperPanel';

afterEach(cleanup);

const ITEM = '300000001';
const PAGE_URL = `https://www.homedepot.com/p/RYOBI-ONE-18V-6-Tool-Combo-Kit-PCL1600K2/${ITEM}`;
const NOW = Date.parse('2026-11-22T12:00:00Z');

const ROW: DealRow = {
  id: 'RYOBI:PCL1600K2',
  bundle: { brand: 'RYOBI', model: 'PCL1600K2', title: 'RYOBI ONE+ 18V 6-Tool Combo Kit', itemId: ITEM, link: PAGE_URL },
  section: 'confirmed',
  price: 249,
  regularPrice: 399,
  off: 37.6,
  matchState: '5 of 6 parts matched',
  profit: 112.4,
  roi: 0.45,
  roiRange: { low: 0.3, high: 0.5 },
  needsAnswer: true,
  updatedAt: '2026-11-22T10:00:00.000Z',
};
const DETAIL: DealDetail = {
  row: ROW,
  bundle: {} as never,
  sources: [
    { label: 'Home Depot: RYOBI PCL1600K2', url: PAGE_URL, source: 'homedepot' },
    { label: 'Amazon: PCL206B', url: 'https://www.amazon.com/dp/B0TEST0001', source: 'amazon' },
  ],
  estimateBasis: 'Estimated from your fee settings, not your real Amazon fees.',
};
const ITEM_Q: ReviewItem = {
  id: 'split:RYOBI:PCL1600K2',
  kind: 'split',
  subject: 'RYOBI:PCL1600K2',
  brand: 'RYOBI',
  model: 'PCL1600K2',
  title: 'RYOBI ONE+ 18V 6-Tool Combo Kit',
  reason: 'The page lists two readings of this kit.',
  candidates: [],
  choices: [['PCL206B', 'PCL235B']],
  openedAt: 1,
  answer: null,
  answeredAt: null,
};
const QUESTION: ReviewQuestion = {
  id: ITEM_Q.id,
  kind: 'split',
  bundleId: ROW.id,
  brand: 'RYOBI',
  model: 'PCL1600K2',
  title: ITEM_Q.title,
  reason: ITEM_Q.reason,
  sources: [{ label: 'Home Depot: RYOBI PCL1600K2', url: PAGE_URL, source: 'homedepot' }],
  suggestion: null,
  item: { kind: 'split', question: ITEM_Q },
};
const ELSEWHERE: ReviewQuestion = { ...QUESTION, id: 'match:x', bundleId: 'DEWALT:DCK240C2', item: { kind: 'match', question: { ...ITEM_Q, id: 'match:x', kind: 'match' } } };

const ok = <T,>(data: T): AgentReply<T> => ({ ok: true, status: 200, data });

function fakeAgent(over: { deals?: DealRow[]; questions?: ReviewQuestion[]; detail?: AgentReply<DealDetail>; reach?: boolean; answerError?: string } = {}) {
  const posts: { path: string; body: unknown }[] = [];
  const reach = over.reach ?? true;
  const down: AgentReply<never> = { ok: false, kind: 'unreachable', status: 0, message: NOTICE_UNREACHABLE };
  const agent: AgentApi = {
    get: (async (path: string) => {
      if (!reach) return down;
      if (path === '/api/deals') return ok<DealsResponse>({ at: null, sort: 'profit', rows: over.deals ?? [ROW], staleDays: null, notices: { limit: null, ebay: null } });
      if (path === '/api/review') return ok<ReviewResponse>({ at: null, questions: over.questions ?? [QUESTION, ELSEWHERE] });
      if (path === `/api/deals/${encodeURIComponent(ROW.id)}`) return over.detail ?? ok(DETAIL);
      return { ok: false, kind: 'refused', status: 404, message: 'No such thing.' };
    }) as AgentApi['get'],
    post: (async (path: string, body?: unknown) => {
      posts.push({ path, body });
      return over.answerError ? { ok: false, kind: 'refused', status: 404, message: over.answerError } : ok({ queued: true });
    }) as AgentApi['post'],
  };
  return { agent, posts };
}

function tabApi(url: string | null): WorkerApi {
  return {
    send: (async () => ({ ok: false, error: 'unused' })) as WorkerApi['send'],
    onStateChanged: () => () => {},
    download: () => {},
    tabs: { active: async () => (url === null ? null : { id: 1, url }), onChanged: () => () => {}, onShowThisPage: () => () => {} },
  };
}

const PAIRED: Extract<AgentLink, { status: 'paired' }> = { status: 'paired', since: NOW - 3_600_000, lastJobAt: NOW - 2 * 60_000 };
const actions = (): AgentLinkActions & { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } => ({ connect: vi.fn(async () => null), disconnect: vi.fn(async () => null) });

function panel(url: string | null, agent: AgentApi, a: AgentLinkActions = actions()) {
  return render(createElement(HelperPanel, { api: tabApi(url), agent, link: PAIRED, actions: a, now: () => NOW }));
}

describe('homeDepotItemId', () => {
  it('reads the item id of a Home Depot product address and nothing else', () => {
    expect(homeDepotItemId({ id: 1, url: PAGE_URL })).toBe(ITEM);
    expect(homeDepotItemId({ id: 1, url: `https://example.com/p/x/${ITEM}` })).toBeNull();
    expect(homeDepotItemId({ id: 1, url: 'https://www.homedepot.com/s/ryobi' })).toBeNull();
    expect(homeDepotItemId({ id: 1, url: null })).toBeNull();
    expect(homeDepotItemId(null)).toBeNull();
  });
  it('drops the signature the panel adds to an answer', () => {
    expect(apiAnswer({ choice: 1, seen: 's' })).toEqual({ choice: 1 });
    expect(apiAnswer({ none: true, seen: 's' })).toEqual({ none: true });
    expect(apiAnswer({ parts: ['A'], seen: 's' })).toEqual({ parts: ['A'] });
  });
});

describe('the helper panel', () => {
  it('shows the bundle open in the tab as the app has it: price, an estimate called an estimate, and labelled sources', async () => {
    const { agent } = fakeAgent();
    panel(PAGE_URL, agent);
    expect(await screen.findByText('RYOBI ONE+ 18V 6-Tool Combo Kit')).toBeInTheDocument();
    expect(screen.getByText('$249.00')).toBeInTheDocument();
    expect(screen.getByText('5 of 6 parts matched')).toBeInTheDocument();
    expect(screen.getByText('Estimated profit')).toBeInTheDocument();
    expect(screen.getByText('+$112.40')).toBeInTheDocument();
    expect(screen.getByText('45%')).toBeInTheDocument();
    expect(screen.getByText('Estimated from your fee settings, not your real Amazon fees.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Amazon: PCL206B' })).toHaveAttribute('href', 'https://www.amazon.com/dp/B0TEST0001');
    expect(screen.getByRole('link', { name: 'Home Depot: RYOBI PCL1600K2' })).toHaveAttribute('target', '_blank');
  });

  it('says the connection and the last job, and that the app is opened from the Dock or Start menu', async () => {
    const { agent } = fakeAgent();
    panel(PAGE_URL, agent);
    expect(await screen.findByText('Connected to the app')).toBeInTheDocument();
    expect(screen.getByText('last job 2 min ago')).toBeInTheDocument();
    expect(screen.getByText(OPEN_APP_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it("lists this bundle's open question, counts the others, and sends an answer to the app without the panel's signature", async () => {
    const user = userEvent.setup();
    const { agent, posts } = fakeAgent();
    panel(PAGE_URL, agent);
    expect(await screen.findByText('Which parts come in this bundle?')).toBeInTheDocument();
    expect(screen.getByText('1 more question waits in the app.')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /PCL206B \+ PCL235B/ }));
    await user.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: `/api/review/${encodeURIComponent(ITEM_Q.id)}/answer`, body: { answer: { choice: 0 } } });
    expect(await screen.findByText('Answer sent to the app. It applies it in a moment.')).toBeInTheDocument();
  });

  it("shows the app's own sentence when it refuses an answer, and keeps the question", async () => {
    const user = userEvent.setup();
    const { agent } = fakeAgent({ answerError: 'No open question with this id.' });
    panel(PAGE_URL, agent);
    await user.click(await screen.findByRole('radio', { name: /PCL206B \+ PCL235B/ }));
    await user.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(await screen.findByText('No open question with this id.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save answer' })).toBeInTheDocument();
  });

  it('a bundle the app has not scanned says so and says what this panel cannot do', async () => {
    const { agent } = fakeAgent({ deals: [] });
    panel(PAGE_URL, agent);
    expect(await screen.findByText(NOT_IN_APP)).toBeInTheDocument();
  });

  it('a page that is not a Home Depot product asks for one, and still counts the questions waiting in the app', async () => {
    const { agent } = fakeAgent();
    panel('https://example.com/', agent);
    expect(await screen.findByText(NO_PAGE)).toBeInTheDocument();
    expect(await screen.findByText('2 more questions wait in the app.')).toBeInTheDocument();
  });

  it('an app that is not running is one plain sentence', async () => {
    const { agent } = fakeAgent({ reach: false });
    panel(PAGE_URL, agent);
    expect(await screen.findByRole('alert')).toHaveTextContent(NOTICE_UNREACHABLE);
  });

  it('a row with no detail still shows what the row says', async () => {
    const { agent } = fakeAgent({ detail: { ok: false, kind: 'refused', status: 404, message: 'No such deal.' } });
    panel(PAGE_URL, agent);
    expect(await screen.findByText('+$112.40')).toBeInTheDocument();
    expect(screen.getByText('Profit is an estimate from your fee settings, not your real Amazon fees.')).toBeInTheDocument();
  });

  it('Disconnect asks the background to disconnect', async () => {
    const user = userEvent.setup();
    const { agent } = fakeAgent();
    const a = actions();
    panel(PAGE_URL, agent, a);
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(a.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('the side panel by link state', () => {
  const store = (link: AgentLink): Pick<LinkStore, 'readLink'> => ({ readLink: async () => link });

  it('paired: the helper view, not the full panel', async () => {
    const { agent } = fakeAgent();
    render(createElement(App, { api: tabApi(PAGE_URL), agent, linkStore: store(PAIRED), linkActions: actions(), now: () => NOW }));
    expect(await screen.findByText('Connected to the app')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scan now' })).toBeNull();
  });

  it('not paired and no key: first run, with the way to connect, and the code once pairing has started', async () => {
    const user = userEvent.setup();
    const a = actions();
    const noKey: WorkerApi = {
      ...tabApi(null),
      send: (async (r: { type: string }) => (r.type === 'getState' ? { ok: true, data: { hasKey: false, account: null, accountCheckedAt: null, problem: null, settings: DEFAULT_SETTINGS, scanRunning: false, lastJob: null, nextRunAt: null } } : { ok: false, error: 'x' })) as WorkerApi['send'],
    };
    const { unmount } = render(createElement(App, { api: noKey, linkStore: store(UNPAIRED), linkActions: a, now: () => NOW }));
    await user.click(await screen.findByRole('button', { name: 'Connect to the Split Finder app' }));
    expect(a.connect).toHaveBeenCalledTimes(1);
    unmount();
    render(createElement(App, { api: noKey, linkStore: store({ status: 'pairing', code: '482913', expiresAt: NOW + 9 * 60_000 }), linkActions: a, now: () => NOW }));
    expect(await screen.findByText(/approve code/)).toHaveTextContent('Enter nothing — approve code 482 913 in the app.');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('not paired because the app forgot this browser: the full panel comes back with the sentence and the way to connect again', async () => {
    const full: WorkerApi = {
      ...tabApi(null),
      send: (async (r: { type: string }) =>
        r.type === 'getState'
          ? { ok: true, data: { hasKey: true, account: null, accountCheckedAt: null, problem: null, settings: DEFAULT_SETTINGS, scanRunning: false, lastJob: null, nextRunAt: null } }
          : r.type === 'getReport'
            ? { ok: true, data: { bundles: [], review: [], packaging: {} } }
            : { ok: true, data: null }) as WorkerApi['send'],
    };
    render(createElement(App, { api: full, linkStore: store({ status: 'unpaired', notice: NOTICE_REVOKED }), linkActions: actions(), now: () => NOW }));
    expect(await screen.findByText(NOTICE_REVOKED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect to the Split Finder app' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Scan now' })).toBeInTheDocument();
  });
});
