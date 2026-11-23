import { describe, expect, it } from 'vitest';
import type * as C from '@core/api/contract';
import type { PartRow } from '@core/scan/types';
import { mergePatch } from '../lib/patch';
import { csvSort, gradeOf, mapEvent, mapRow, mapState, mapSuggestion, scanResult } from './map';
import { backoffMs, createSseParser } from './sse';

const part = (p: Partial<PartRow>): PartRow =>
  ({ model: 'DCF885B', qty: 1, status: 'matched', availability: 'active', asin: 'B00DL7QDBW', grade: 'exact', price: 89, priceSeenAt: 1, image: null, title: 'Impact Driver', prices: [], ...p }) as PartRow;

describe('a part\'s grade, in the order core reads a part', () => {
  it('is not looked up while the part waits, whatever grade it carries', () => {
    expect(gradeOf(part({ status: 'waiting', grade: 'exact' }))).toBe('not_looked_up');
    expect(gradeOf(part({ status: 'unmatched', grade: null }))).toBe('not_looked_up');
  });
  it('says missing or inactive before it says a match grade', () => {
    expect(gradeOf(part({ status: 'none', availability: 'missing' }))).toBe('missing');
    expect(gradeOf(part({ availability: 'inactive' }))).toBe('inactive');
  });
  it('verified for exact and strong, title match for probable, an answer for anything less', () => {
    expect(gradeOf(part({ grade: 'strong' }))).toBe('verified');
    expect(gradeOf(part({ grade: 'probable' }))).toBe('title_match');
    expect(gradeOf(part({ grade: 'review' }))).toBe('needs_answer');
    expect(gradeOf(part({ status: 'review', grade: 'exact' }))).toBe('needs_answer');
  });
});

describe('the agent state', () => {
  const base: C.AgentState = {
    agent: { status: 'scanning', busy: 'ask', nextScanAt: null, lastScan: { at: '2026-11-22T10:00:00.000Z', status: 'limit', stopMessage: 'Stopped at your reserve.', searchesUsed: 3, keepaTokensUsed: 0, newDeals: 1, reviewOpen: 2 } },
    helper: { paired: true, connected: false, lastSeenAt: null },
    budget: { serpLeft: null, serpReserve: 20, keepaTokens: null, aiSpentUsd: 0, aiCapUsd: 20 },
    counts: { review: 2, autopilotApplied: 0, newDeals: 1, jobsWaiting: 4 },
    keys: { serpapi: true, keepa: false, anthropic: false, openai: false, ebay: false, telegram: false },
  };
  it('reads a scanning agent that is asking the AI as asking, and a limit stop as one', () => {
    const s = mapState(base);
    expect(s.agent.status).toBe('asking');
    expect(s.agent.lastScan).toMatchObject({ result: 'limit', searches: 3, message: 'Stopped at your reserve.' });
  });
  it('keeps what it does not know as null, and takes the waiting pages from the counts', () => {
    const s = mapState(base);
    expect(s.budget.serpLeft).toBeNull();
    expect(s.budget.serpMonthly).toBeNull();
    expect(s.helper.jobsWaiting).toBe(4);
    expect(s.firstRun).toBe(false);
  });
  it('carries the unread-page and outdated-helper fields when the agent sends them, and nothing when it does not', () => {
    expect(mapState(base).agent.lastScan).not.toHaveProperty('pagesUnread');
    expect(mapState(base).helper).not.toHaveProperty('outdated');
    const next = structuredClone(base) as C.AgentState & { agent: { lastScan: Record<string, unknown> }; helper: Record<string, unknown> };
    next.agent.lastScan.pagesUnread = 16;
    next.agent.lastScan.canReadPagesAgain = true;
    next.helper.outdated = true;
    next.helper.version = '0.4.1';
    const s = mapState(next);
    expect(s.agent.lastScan).toMatchObject({ pagesUnread: 16, canReadPagesAgain: true });
    expect(s.helper).toMatchObject({ outdated: true, version: '0.4.1' });
  });
  it('tells a stop the owner asked for from one the agent made', () => {
    const stop = (stopMessage: string | null) => mapState({ ...base, agent: { ...base.agent, lastScan: { ...base.agent.lastScan!, status: 'stopped', stopMessage } } }).agent.lastScan;
    expect(stop(null)?.userStopped).toBe(true);
    expect(stop('Home Depot refused a page (HTTP 200).')?.userStopped).toBeUndefined();
  });
  it('words a status the agent never sends as failed, not as a success', () => {
    expect(scanResult('unknown')).toBe('failed');
    expect(scanResult('running')).toBe('running');
  });
});

describe('a suggestion', () => {
  const choices = [
    { id: 'choice:0', label: 'DCF891B, DCD708B', models: ['DCF891B', 'DCD708B'], asin: null, source: null },
    { id: 'choice:1', label: 'DCF921B, DCD708B', models: ['DCF921B', 'DCD708B'], asin: null, source: null },
  ];
  const question = (rec: C.ReviewQuestion['suggestion'], seen = '[["DCF891B","DCD708B"],["DCF921B","DCD708B"]]'): C.ReviewQuestion =>
    ({ id: 'split:K', kind: 'split', bundleId: 'K', brand: 'DEWALT', model: 'DCK200', title: 'T', reason: 'r', sources: [], suggestion: rec, seen }) as unknown as C.ReviewQuestion;
  const stored = (suggestion: object, seen: string): C.ReviewQuestion['suggestion'] =>
    ({ key: 'split:K|1', questionId: 'split:K', seen, askedAt: 1, costUsd: 0.09, suggestion: { questionId: 'split:K', seen, provider: 'anthropic', model: 'claude-sonnet-4-5', promptVersion: 'v', ...suggestion } }) as C.ReviewQuestion['suggestion'];
  const quote = { quote: 'Includes DCF921B', sourceId: 'bundle', label: 'Home Depot page', url: 'https://www.homedepot.com/p/1', names: true };

  it('is verified for the choice it names, with its quote and cost', () => {
    const sig = '[["DCF891B","DCD708B"],["DCF921B","DCD708B"]]';
    const got = mapSuggestion(question(stored({ status: 'verified', answer: { decision: 'choose', kind: 'split', choiceIndex: 1, parts: ['DCF921B', 'DCD708B'] }, quotes: [quote], reason: 'r' }, sig)), choices);
    expect(got).toMatchObject({ status: 'verified', choiceId: 'choice:1', answer: 'DCF921B + DCD708B', costUsd: 0.09 });
    expect(got?.quotes[0]).toEqual({ text: 'Includes DCF921B', source: { label: 'Home Depot page', url: 'https://www.homedepot.com/p/1' } });
  });
  it('is dropped when it was made for choices the question no longer has (rule 4)', () => {
    const got = mapSuggestion(question(stored({ status: 'verified', answer: { decision: 'choose', kind: 'split', choiceIndex: 1, parts: ['DCF921B'] }, quotes: [quote], reason: 'r' }, 'an older question')), choices);
    expect(got).toBeNull();
  });
  it('is never verified when the AI said none fits', () => {
    const sig = '[["DCF891B","DCD708B"],["DCF921B","DCD708B"]]';
    const got = mapSuggestion(question(stored({ status: 'none_suggested', reason: 'No reading fits.', quotes: [quote] }, sig)), choices);
    expect(got).toMatchObject({ status: 'unverified', choiceId: null, answer: 'None of these fits' });
  });
  it('says why it could not tell, with no choice preselected', () => {
    const sig = '[["DCF891B","DCD708B"],["DCF921B","DCD708B"]]';
    const got = mapSuggestion(question(stored({ status: 'cannot_tell', reason: 'The pages disagree.', quotes: [] }, sig)), choices);
    expect(got).toMatchObject({ status: 'cannot_tell', choiceId: null, reason: 'The pages disagree.' });
  });
});

describe('events', () => {
  it('reads the state out of a state event and the rest by their type', () => {
    const state = { agent: { status: 'idle', nextScanAt: null, lastScan: null }, helper: { paired: false, connected: false, lastSeenAt: null }, budget: { serpLeft: 10, serpReserve: 20, keepaTokens: null, aiSpentUsd: 0, aiCapUsd: null }, counts: { review: 0, autopilotApplied: 0, newDeals: 0, jobsWaiting: 0 }, keys: {} };
    expect(mapEvent('state', { ...state, type: 'state', state })).toMatchObject({ type: 'state', state: { budget: { serpLeft: 10 } } });
    expect(mapEvent('deals', { type: 'deals', at: null, count: 3 })).toEqual({ type: 'deals' });
    expect(mapEvent('notify', { type: 'notify', id: 'n', kind: 'scan', title: 'Scan', body: 'Done', count: 1 })).toEqual({ type: 'notify', title: 'Scan', body: 'Done' });
    expect(mapEvent('mystery', { type: 'mystery' })).toBeNull();
  });
  it('parses what the agent writes: a retry line, then an id, event and data', () => {
    const got: string[] = [];
    const feed = createSseParser((m) => got.push(`${m.event}:${m.data}`));
    feed('retry: 3000\n\nid: 1\nevent: review\ndata: {"type":"review","open":2}\n\n: ping\n\n');
    expect(got).toEqual(['review:{"type":"review","open":2}']);
  });
  it('waits longer after each failure, up to 30 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe('small pieces', () => {
  it('asks the agent for the sort it has', () => {
    expect([csvSort('profit'), csvSort('roi'), csvSort('off'), csvSort('title')]).toEqual(['profit', 'roi', 'discount', 'profit']);
  });
  it('merges two settings edits made inside one wait into one patch', () => {
    expect(mergePatch({ settings: { reserve: 30 } }, { settings: { searchesPerScan: 8 }, autopilot: false } as never)).toEqual({ settings: { reserve: 30, searchesPerScan: 8 }, autopilot: false });
  });
});

describe('a deal row\'s tracking flags', () => {
  const wire = (extra: Partial<C.DealRow>): C.DealRow => ({
    id: 'hd-1', bundle: { brand: 'DEWALT', model: 'DCK240C2', title: 'Combo Kit', itemId: '204373168', link: null }, section: 'confirmed', price: 149, regularPrice: 239, off: 38,
    matchState: null, profit: 38.1, roi: 0.2557, roiRange: { low: null, high: null }, needsAnswer: false, updatedAt: '2026-11-23T10:00:00.000Z', ...extra,
  });
  it('reads watched, buy now and BOGO as sent', () => {
    expect(mapRow(wire({ watched: true, buyNow: true, bogo: 'choose' }))).toMatchObject({ watched: true, buyNow: true, bogo: 'choose' });
  });
  it('reads an older agent that sends none of them as not watched, not worth buying now and no promotion', () => {
    expect(mapRow(wire({}))).toMatchObject({ watched: false, buyNow: false, bogo: null, bogoPair: null, bogoChoices: null });
  });
  it('reads waiting_page, from its own field or as the match state, as waiting: never as a question', () => {
    expect(mapRow({ ...wire({ needsAnswer: true }), matchKind: 'waiting_page' } as C.DealRow)).toMatchObject({ matchKind: 'waiting_page', needsAnswer: false });
    expect(mapRow(wire({ needsAnswer: true, matchState: 'waiting_page' }))).toMatchObject({ matchKind: 'waiting_page', needsAnswer: false });
    expect(mapRow(wire({ needsAnswer: true }))).toMatchObject({ needsAnswer: true });
    expect(mapRow(wire({}))).not.toHaveProperty('matchKind');
  });
  it('reads the BOGO pair and its group as sent (the recorded DEWALT pair)', () => {
    const bogoPair = { promotionId: '945972', starterItemId: '334337675', starterModel: 'DCK200D1P1', freeModel: '921B', endsAt: '2027-01-31', description: 'BUY A DEWALT CORDLESS KIT GET A FREE BARE TOOL' };
    const bogoChoices = { label: 'BOGO: 2 free-tool choices \u2014 none has an estimate yet', count: 2, bestId: null, best: false };
    expect(mapRow(wire({ bogoPair, bogoChoices }))).toMatchObject({ bogoPair, bogoChoices });
  });
});
