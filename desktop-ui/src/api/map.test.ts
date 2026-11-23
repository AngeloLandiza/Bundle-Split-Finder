import { describe, expect, it } from 'vitest';
import type * as C from '@core/api/contract';
import type { PartRow } from '@core/scan/types';
import { mergePatch } from '../lib/patch';
import { csvSort, gradeOf, keyChecksOf, mapEvent, mapRow, mapState, mapSuggestion, readBrief, readFollowUp, readSettled, scanResult, splitEvidenceOf } from './map';
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
    expect(got).toMatchObject({ status: 'unmatched', choiceId: null, answer: 'None of these fits' });
  });
  it('names the offered choice an unverified answer claims, with the AI’s quotes linked to their sources', () => {
    const sig = '[["DCF891B","DCD708B"],["DCF921B","DCD708B"]]';
    const claimed = { evidence: [{ quote: 'DCK240C2DCS380B', source: 'bundle' }, { quote: 'DEWALT DCK240C2 (kit): 20V MAX Cordless Drill/Impact 2 Tool Combo Kit', source: 'catalog:dck240c2' }], reason: 'The page names DCS380B.', decision: 'choose', choiceIndex: 1, asin: null };
    const q = { ...question(stored({ status: 'unverified', reasons: ['No quote names DCF921B.'], claimed }, sig)), bundleId: 'homedepot:306554196', sources: [{ source: 'homedepot', label: 'Home Depot', url: 'https://www.homedepot.com/p/306554196' }] } as C.ReviewQuestion;
    const got = mapSuggestion(q, choices);
    expect(got).toMatchObject({ status: 'unverified', choiceId: 'choice:1', reason: 'The page names DCS380B.', notVerified: 'No quote names DCF921B.' });
    expect(got?.quotes.map((x) => x.source)).toEqual([{ label: 'Home Depot bundle page', url: 'https://www.homedepot.com/p/306554196' }, { label: 'Catalog entry', url: null }]);
  });
  it('keeps the parts a research answer typed in as its own state when no choice holds them', () => {
    const sig = '[["DCF891B","DCD708B"],["DCF921B","DCD708B"]]';
    const researchClaim = { decision: 'parts', reason: 'Two kits.', parts: [{ model: 'PCL1600K2', qty: 1, quotes: [{ quote: 'Includes ONE+ 18V 6-Tool Combo Kit', sourceId: 'hd-page:320243671' }] }, { model: 'A986501', qty: 1, quotes: [] }] };
    const got = mapSuggestion({ ...question(stored({ status: 'unverified', reasons: ['The bundle’s title names a drill that no part is or holds.'], claimed: null, researchClaim }, sig)), bundleId: 'homedepot:111' } as C.ReviewQuestion, choices);
    expect(got).toMatchObject({ status: 'unmatched', choiceId: null, answer: 'PCL1600K2 + A986501' });
    expect(got?.quotes[0]?.source).toEqual({ label: 'Home Depot part page', url: 'https://www.homedepot.com/p/320243671' });
  });
  it('takes the parts a research answer typed in for the offered reading that holds exactly those parts, and for no other', () => {
    const sig = '[["DCF891B","DCD708B"],["DCF921B","DCD708B"]]';
    const typedAs = (parts: { model: string; qty: number }[]) => mapSuggestion(question(stored({ status: 'unverified', reasons: ['x'], claimed: null, researchClaim: { decision: 'parts', reason: 'r', parts } }, sig)), choices);
    expect(typedAs([{ model: 'dcd708b', qty: 1 }, { model: 'DCF921B', qty: 1 }])).toMatchObject({ status: 'unverified', choiceId: 'choice:1' });
    expect(typedAs([{ model: 'DCF921B', qty: 1 }])).toMatchObject({ status: 'unmatched', choiceId: null });
    expect(typedAs([{ model: 'DCF921B', qty: 2 }, { model: 'DCD708B', qty: 1 }])).toMatchObject({ status: 'unmatched', choiceId: null });
  });
  it('carries the agent’s plain words for why it is not verified', () => {
    const sig = '[["DCF891B","DCD708B"],["DCF921B","DCD708B"]]';
    const q = { ...question(stored({ status: 'unverified', reasons: ['x'], claimed: { decision: 'choose', choiceIndex: 0, evidence: [] } }, sig)), suggestionPlain: 'The page never names the saw.' } as C.ReviewQuestion;
    expect(mapSuggestion(q, choices)?.plain).toBe('The page never names the saw.');
  });
  it('says why it could not tell, with no choice preselected', () => {
    const sig = '[["DCF891B","DCD708B"],["DCF921B","DCD708B"]]';
    const got = mapSuggestion(question(stored({ status: 'cannot_tell', reason: 'The pages disagree.', quotes: [] }, sig)), choices);
    expect(got).toMatchObject({ status: 'cannot_tell', choiceId: null, reason: 'The pages disagree.' });
  });
});

describe('the fields the new agent adds', () => {
  const base = { agent: { status: 'idle', nextScanAt: null, lastScan: { at: '2026-11-23T10:00:00Z', status: 'finished', stopMessage: null, searchesUsed: 1, keepaTokensUsed: 0, newDeals: 0, reviewOpen: 0, waitingLookups: 18, lookupsDone: { keepa: 2, serpapi: 1 }, lookupsBlockedBy: 'keepa_tokens' }, drip: { active: true, waiting: 18, nextAt: '2026-11-23T10:10:00Z', lastLookupAt: null } }, helper: { paired: true, connected: true, lastSeenAt: null }, budget: { serpLeft: 119, serpReserve: 100, keepaTokens: 57, keepaRefillPerMin: 1, aiSpentUsd: 0, aiCapUsd: null }, counts: { review: 0, autopilotApplied: 0, newDeals: 0, jobsWaiting: 0 }, keys: { ebay: true }, keyProblems: { ebay: 'eBay did not accept the App ID and Cert ID.', telegram: '  ', bogus: 'x' } };
  it('reads the lookups, the drip, Keepa’s refill and the key problems, and only with their types', () => {
    const got = mapState(base as unknown as C.AgentState);
    expect(got.agent.lastScan).toMatchObject({ waitingLookups: 18, lookupsDone: { keepa: 2, serpapi: 1 }, lookupsBlockedBy: 'keepa_tokens' });
    expect(got.agent.drip).toEqual({ active: true, waiting: 18, nextAt: '2026-11-23T10:10:00Z', lastLookupAt: null });
    expect(got.budget.keepaRefillPerMin).toBe(1);
    expect(got.keyProblems).toEqual({ ebay: 'eBay did not accept the App ID and Cert ID.' });
  });
  it('leaves them out for an older agent', () => {
    const old = mapState({ ...base, agent: { status: 'idle', nextScanAt: null, lastScan: null }, keyProblems: undefined, budget: { ...base.budget, keepaRefillPerMin: undefined } } as unknown as C.AgentState);
    expect(old.agent.drip).toBeUndefined();
    expect(old.keyProblems).toBeUndefined();
    expect(old.budget.keepaRefillPerMin).toBeUndefined();
  });
  it('reads a bundle waiting for Home Depot’s part pages as a waiting state, not a question', () => {
    const row = { id: 'K', bundle: { brand: 'RYOBI', model: 'PCL1201K2-FVC51K', title: 'T', itemId: null, link: null }, section: 'waiting', price: 179, regularPrice: 199, off: 10, matchState: 'waiting_parts', profit: null, roi: null, roiRange: { low: null, high: null }, needsAnswer: true, updatedAt: '2026-11-23T10:00:00Z' };
    expect(mapRow(row as unknown as C.DealRow)).toMatchObject({ matchKind: 'waiting_parts', matchState: null, needsAnswer: false });
  });
  it('Nov 23: carries a bundle missing a price as the agent sends it, with no profit, and nothing for a complete one', () => {
    const incomplete = { priced: 1, total: 2, pricedNet: 140.25, breakEvenNet: 158.75, breakEvenPrice: 186.76, unpriced: ['DCK200D1P1'] };
    const row = { id: 'K', bundle: { brand: 'DEWALT', model: 'DCK200D1P1W921B', title: 'T', itemId: null, link: null }, section: 'missing_listing', price: 299, regularPrice: 538, off: 44, matchState: '1 part with no listing', profit: null, roi: null, roiRange: { low: null, high: null }, needsAnswer: false, updatedAt: '2026-11-23T10:00:00Z', incomplete };
    expect(mapRow(row as unknown as C.DealRow)).toMatchObject({ profit: null, roi: null, incomplete });
    expect(mapRow({ ...row, incomplete: null, profit: 6.63, roi: 0.037 } as unknown as C.DealRow).incomplete).toBeUndefined();
  });
  it('keeps split evidence with a kind and a text, and an address only when it is http(s)', () => {
    expect(splitEvidenceOf([{ kind: 'hd_part_page', text: 'Home Depot sells PCL1201K2', url: 'https://www.homedepot.com/p/1' }, { kind: 'page_quote', text: 'Includes: a', url: 'javascript:alert(1)' }, { kind: 'mystery', text: 'x' }, { kind: 'bogo_pair', text: '' }])).toEqual([
      { kind: 'hd_part_page', text: 'Home Depot sells PCL1201K2', url: 'https://www.homedepot.com/p/1' },
      { kind: 'page_quote', text: 'Includes: a' },
    ]);
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

describe('what the app did about a question', () => {
  const step = { what: 'Searched Home Depot for RYOBI A21701', result: 'found: 15-Piece Router Bit Set', url: 'https://www.homedepot.com/s/A21701' };
  it('reads a follow-up as sent, and drops one without the promised shape', () => {
    expect(readFollowUp({ state: 'running', doing: " Reading Home Depot's page for A21701 ", tried: [step], roundsLeft: 2 })).toEqual({ state: 'running', doing: "Reading Home Depot's page for A21701", tried: [step], roundsLeft: 2 });
    expect(readFollowUp({ state: 'done', tried: [], roundsLeft: 0 })).toEqual({ state: 'done', tried: [], roundsLeft: 0 });
    expect(readFollowUp({ state: 'thinking', tried: [], roundsLeft: 0 })).toBeUndefined();
    expect(readFollowUp({ state: 'done', tried: [{ what: 'x' }], roundsLeft: 0 })).toBeUndefined();
    expect(readFollowUp({ state: 'done', tried: [], roundsLeft: '1' })).toBeUndefined();
    expect(readFollowUp(null)).toBeUndefined();
  });
  it("reads who does the brief's check, and ignores a value it does not know", () => {
    const brief = (who: unknown) => ({ ask: 'What is inside this bundle?', suggestion: null, state: 'none', reasons: [], check: { text: 'Decide whether they are worth listing apart.', who }, writtenBy: 'ai' });
    expect(readBrief(brief('owner'))?.check?.who).toBe('owner');
    expect(readBrief(brief('app'))?.check?.who).toBe('app');
    expect(readBrief(brief('robot'))?.check).not.toHaveProperty('who');
  });
  it('carries the working count when the agent sends it, and nothing from an older one', () => {
    const state = { agent: { status: 'idle', nextScanAt: null, lastScan: null }, helper: { paired: true, connected: true, lastSeenAt: null }, budget: { serpLeft: 100, serpReserve: 20, keepaTokens: null, aiSpentUsd: 0, aiCapUsd: 20 }, keys: { serpapi: true, keepa: false, anthropic: true, openai: false, ebay: false, telegram: false } };
    const counts = (c: object) => mapState({ ...state, counts: { review: 3, autopilotApplied: 0, newDeals: 0, jobsWaiting: 0, ...c } } as unknown as C.AgentState).counts;
    expect(counts({ reviewWorking: 2 })).toEqual({ review: 3, autopilotApplied: 0, newDeals: 0, reviewWorking: 2 });
    expect(counts({})).not.toHaveProperty('reviewWorking');
  });
});

describe('settled and unsettled parts', () => {
  it('maps the two optional fields and drops what is malformed', () => {
    const got = readSettled({
      settledParts: [{ model: ' A21701 ', what: '7-Piece 5 in. Random Orbit Sand Paper Assortment Set', url: 'https://www.homedepot.com/p/1' }, { model: 'X' }, { model: '', what: 'y' }, { model: 'B1', what: 'no link' }],
      unsettledParts: ['PCL406424SB', 3, ' A25RS51 ', ''],
    });
    expect(got.settledParts).toEqual([{ model: 'A21701', what: '7-Piece 5 in. Random Orbit Sand Paper Assortment Set', url: 'https://www.homedepot.com/p/1' }, { model: 'B1', what: 'no link' }]);
    expect(got.unsettledParts).toEqual(['PCL406424SB', 'A25RS51']);
  });
  it('maps nothing when both are absent', () => {
    expect(readSettled({})).toEqual({});
    expect(readSettled({ settledParts: [], unsettledParts: [] })).toEqual({});
  });
});

describe('keyChecksOf', () => {
  it('keeps a record with a verdict and a time, for a key the agent knows, and drops the rest', () => {
    expect(
      keyChecksOf({
        ebay: { ok: false, at: '2026-11-23T12:00:00.000Z' },
        keepa: { ok: true, at: '2026-11-23T12:01:00.000Z', detail: ' 60 tokens, 1 a minute ' },
        serpapi: { ok: 'yes', at: '2026-11-23T12:00:00.000Z' },
        anthropic: { ok: true, at: 'not a time' },
        nobody: { ok: true, at: '2026-11-23T12:00:00.000Z' },
      }),
    ).toEqual({ ebay: { ok: false, at: '2026-11-23T12:00:00.000Z' }, keepa: { ok: true, at: '2026-11-23T12:01:00.000Z', detail: '60 tokens, 1 a minute' } });
    expect(keyChecksOf(undefined)).toBeUndefined();
    expect(keyChecksOf({})).toBeUndefined();
  });
});
