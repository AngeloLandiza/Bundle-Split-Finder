import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import { REQUESTS } from '../../scripts/fixture-requests';
import {
  type Labels, parseValidateArgs, runValidateCli, scoreCriterion6, scoreLines, type ValidateDeps, VALIDATION_DATE, type ValidationResults, writeResponses,
} from '../../scripts/validate-cli';
import { parseProductPage } from '../src/hdPage';
import { SearchBudget } from '../src/serpapi/budget';
import { cacheKey, type LedgerEntry, MemoryCache, SerpApiClient } from '../src/serpapi/client';

// The validation harness on a small world of real data: three pages of the validation set
// (PCL1600K2-P553, DCK540D1WCS334B, PCL1201K2-PCL515B), the recorded kit page of PCL1600K2 (item
// 317987591), and the SerpApi responses recorded in fixtures/recorded/. No test opens the paid client:
// openClient either throws or hands back a client over the replay of the recordings.

const RECORDED_AT = Date.UTC(2026, 10, 9, 12);
const PAGES = (JSON.parse(readFileSync('fixtures/validation/pages-2026-11-18.json', 'utf8')) as { pages: Record<string, unknown> }).pages;
const KIT_TEXT = (JSON.parse(readFileSync('fixtures/homedepot-pages/pages-2026-11-10.json', 'utf8')) as { pages: { itemId: string; text: string }[] })
  .pages.find((p) => p.itemId === '317987591')!.text;
const recordedData = (name: string): unknown => JSON.parse(readFileSync(`fixtures/recorded/${name}.json`, 'utf8'));
/** The listing phase's pages: both brands' Amazon page 1 and the default queries' Home Depot page 1. */
const LISTING_PHASE = ['amazon-brand-dewalt-p1', 'amazon-brand-ryobi-p1', 'hd-search-dewalt-combo-p1', 'hd-search-ryobi-combo-p1'];

let dir: string;
let logs: string[];
let deps: ValidateDeps;

/** A disk cache stand-in holding the recordings named (default: all of them), as received at RECORDED_AT. */
async function cacheOf(names: string[] = REQUESTS.map((r) => r.name)): Promise<MemoryCache> {
  const cache = new MemoryCache();
  for (const r of REQUESTS) if (names.includes(r.name)) await cache.set(cacheKey(r.params), { at: RECORDED_AT, data: recordedData(r.name) });
  return cache;
}

function writeSet(inputs: { answers?: boolean; kitPages?: boolean } = {}): void {
  const pick = Object.fromEntries(['320243741', '343992133', '324903619'].map((id) => [id, PAGES[id]]));
  writeFileSync(join(dir, `pages-${VALIDATION_DATE}.json`), JSON.stringify({ about: 'test', pages: pick }));
  if (inputs.answers) {
    writeFileSync(join(dir, `answers-${VALIDATION_DATE}.json`), JSON.stringify({
      about: 'test', answers: { 'PCL1600K2-P553': { parts: ['PCL1600K2', 'P553'], note: 'the title names the 6-tool kit and the miter saw' } },
    }));
  }
  if (inputs.kitPages) {
    writeFileSync(join(dir, `kit-pages-${VALIDATION_DATE}.json`), JSON.stringify({ about: 'test', pages: { 317987591: parseProductPage(KIT_TEXT, '317987591') } }));
  }
}

const readResults = (): ValidationResults => JSON.parse(readFileSync(join(dir, `results-${VALIDATION_DATE}.json`), 'utf8')) as ValidationResults;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'validate-cli-'));
  logs = [];
  deps = {
    log: (line) => logs.push(line),
    dir,
    cache: await cacheOf(),
    openClient: (() => {
      throw new Error('openClient must not be called');
    }) as unknown as ValidateDeps['openClient'],
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const ACCOUNT = { planName: 'Test', status: 'Active', searchesPerMonth: 250, totalSearchesLeft: 250, thisMonthUsage: 0, thisHourSearches: 0, rateLimitPerHour: 250, renewalDate: null };

/** openClient over the replay of every recording, capped at `cap`; the ledger and the calls are kept. */
function paidClient(cap: number) {
  const ledger: LedgerEntry[] = [];
  const opened: unknown[][] = [];
  const release = vi.fn();
  const budget = new SearchBudget(ACCOUNT, { reserve: 0, maxPerRun: cap });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => RECORDED_AT, onSpend: (e) => void ledger.push(e) });
  deps.openClient = (async (...a: unknown[]) => {
    opened.push(a);
    return { client, budget, account: ACCOUNT, allowance: cap, release };
  }) as unknown as ValidateDeps['openClient'];
  return { ledger, opened, release };
}

describe('npm run validate: the arguments', () => {
  it.each([
    [[]], [['--max']], [['--max', '0']], [['--max', '43']], [['--max', '4x']], [['--max', '-1']], [['--max', '5', '--dry-run']],
    [['--dry-run', '--replay']], [['--maxx', '5']], [['--dry']], [['--max=5']], [['--limit', '5']],
  ])('refuses %j without opening a client or writing anything', async (args) => {
    writeSet();
    expect(await runValidateCli(args, deps)).toBe(1);
    expect(logs[0]).toBe('Usage:');
    expect(existsSync(join(dir, `results-${VALIDATION_DATE}.json`))).toBe(false);
  });

  it('takes exactly one mode, and a cap from 1 to the validation bucket', () => {
    expect(parseValidateArgs(['--dry-run'])).toEqual({ kind: 'dry-run' });
    expect(parseValidateArgs(['--replay'])).toEqual({ kind: 'replay' });
    expect(parseValidateArgs(['--max', '1'])).toEqual({ kind: 'max', n: 1 });
    expect(parseValidateArgs(['--max', '42'])).toEqual({ kind: 'max', n: 42 });
  });
});

describe('npm run validate -- --dry-run', () => {
  it('counts the lookups the cache does not hold, opens no client and writes nothing', async () => {
    writeSet();
    deps.cache = await cacheOf(LISTING_PHASE);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in a dry run'));
    expect(await runValidateCli(['--dry-run'], deps)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([`pages-${VALIDATION_DATE}.json`]);
    expect(logs).toContain('Listing phase from the cache: 2 Amazon brand pages, 2 Home Depot pages');
    // DCK540D1WCS334B's parts are both on the DEWALT brand page. PCL1201K2-PCL515B resolves from the Home
    // Depot row of PCL1201K2 and the RYOBI brand page's PCL515B, which also answers PCL515B: the kit is left.
    const at = logs.indexOf('Uncached searches needed now: 1');
    expect(at).toBeGreaterThan(0);
    expect(logs[at + 1]).toBe('  amazon  k=RYOBI PCL1201K2  (panel:lookup:PCL1201K2)');
    expect(logs).toContain('Split answers wanted: 1 (answers-2026-11-18.json: { about, answers: { "<bundle model>": { parts: [...] | "none", note } } })');
    expect(logs).toContain('  RYOBI PCL1600K2-P553  item 320243741: hyphen split, but a part is not in the catalog; page names no models; choices: PCL1600K2+P553');
  });

  it('with the answer and the kit page, lists each uncached lookup once and what it still wants', async () => {
    writeSet({ answers: true, kitPages: true });
    deps.cache = await cacheOf(LISTING_PHASE);
    expect(await runValidateCli(['--dry-run'], deps)).toBe(0);
    const at = logs.findIndex((l) => l.startsWith('Uncached searches needed now: '));
    const n = Number(logs[at]!.slice('Uncached searches needed now: '.length));
    const listed = logs.slice(at + 1, at + 1 + n);
    // The answer resolves PCL1600K2-P553: the kit and the miter saw, then the items its own page lists that no
    // saved listing answers (PCL235, PCL515 and PCL660 are on the RYOBI brand page). PCL1201K2 as before.
    expect(listed.map((l) => /k=RYOBI (\S+)/.exec(l)?.[1]).sort()).toEqual(['P553', 'PBP002', 'PCL1201K2', 'PCL1600K2', 'PCL206', 'PCL430', 'PCL500']);
    expect(new Set(listed).size).toBe(n);
    expect(logs).toContain('Split answers wanted: 0');
  });

  it('counts exactly what the paid run then spends, and the paid run labels every search validation:', async () => {
    writeSet({ answers: true, kitPages: true });
    deps.cache = await cacheOf(LISTING_PHASE);
    expect(await runValidateCli(['--dry-run'], deps)).toBe(0);
    const wanted = Number(logs.find((l) => l.startsWith('Uncached searches needed now: '))!.split(': ')[1]);

    logs = [];
    const { ledger, opened, release } = paidClient(42);
    expect(await runValidateCli(['--max', '42'], deps)).toBe(0);
    expect(opened).toEqual([['validation', 42]]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(ledger).toHaveLength(wanted);
    expect(ledger.every((e) => e.label.startsWith('validation:panel:lookup:'))).toBe(true);
    expect(logs).toContain(`Searches spent: ${wanted} (passes 2)`);
  });
});

describe('npm run validate -- --max N', () => {
  it('never spends past N: the client refuses the next search and the run stops there', async () => {
    writeSet({ answers: true, kitPages: true });
    deps.cache = await cacheOf(LISTING_PHASE);
    const { ledger } = paidClient(2);
    expect(await runValidateCli(['--max', '2'], deps)).toBe(0);
    expect(ledger).toHaveLength(2);
    expect(logs.some((l) => l.startsWith('Stopped: '))).toBe(true);
  });

  it('writes every response it used, key-free, and a replay of them gives the same results with no network', async () => {
    writeSet({ answers: true, kitPages: true });
    deps.cache = await cacheOf(LISTING_PHASE);
    paidClient(42);
    expect(await runValidateCli(['--max', '42'], deps)).toBe(0);
    const paid = readFileSync(join(dir, `results-${VALIDATION_DATE}.json`), 'utf8');
    const responses = join(dir, 'responses');
    const files = readdirSync(responses, { recursive: true }).map(String).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(4);
    for (const f of files) expect(readFileSync(join(responses, f), 'utf8')).not.toMatch(/api_key/i);

    logs = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in a replay'));
    expect(await runValidateCli(['--replay'], deps)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs[0]).toBe(`Replay: ${files.length} recorded responses, no network.`);
    expect(readFileSync(join(dir, `results-${VALIDATION_DATE}.json`), 'utf8')).toBe(paid);
    const results = readResults();
    expect(results.summary.notLookedUp).toBe(0);
    // Every part's match says where it came from, and a lookup's shows the listings it was judged among.
    for (const p of results.bundles.flatMap((b) => b.parts)) {
      expect(p.source).not.toBeNull();
      if (p.source === 'lookup') expect(p.candidates.length).toBeGreaterThan(0);
    }
  });
});

describe('npm run validate -- --replay', () => {
  it('refuses the network: with nothing recorded every lookup waits, and nothing is fetched', async () => {
    writeSet({ answers: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in a replay'));
    expect(await runValidateCli(['--replay'], deps)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logs[0]).toBe('Replay: 0 recorded responses, no network.');
    const results = readResults();
    expect(results.summary.notLookedUp).toBeGreaterThan(0);
    expect(results.bundles.flatMap((b) => b.parts).every((p) => p.status === 'waiting' && p.source === null)).toBe(true);
  });

  it('never reads the disk cache', async () => {
    writeSet();
    const get = vi.fn(() => Promise.resolve(undefined));
    deps.cache = { get };
    expect(await runValidateCli(['--replay'], deps)).toBe(0);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('the recorded responses', () => {
  it('are never written when one names api_key', () => {
    const used = new Map([['engine=amazon&k=RYOBI P553', { at: 1, data: { search_metadata: { json_endpoint: 'https://serpapi.com/x?api_key=SECRET' } } }]]);
    expect(() => writeResponses(join(dir, 'responses'), used)).toThrow(/api_key/);
    expect(existsSync(join(dir, 'responses'))).toBe(false);
  });
});

describe('a paid lookup that fails', () => {
  it('is set aside, not charged and never retried; the run goes on', async () => {
    writeSet({ answers: true, kitPages: true });
    deps.cache = await cacheOf(LISTING_PHASE);
    const ledger: LedgerEntry[] = [];
    const asked: string[] = [];
    const budget = new SearchBudget(ACCOUNT, { reserve: 0, maxPerRun: 42 });
    const replay = replayRecorded();
    const fetchFn = (async (input: string | URL | Request) => {
      const k = new URL(String(input instanceof Request ? input.url : input)).searchParams.get('k');
      asked.push(k ?? '');
      if (k === 'RYOBI P553') return new Response(JSON.stringify({ error: 'refused' }), { status: 500 });
      return replay.fetchFn(input);
    }) as typeof fetch;
    const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn, now: () => RECORDED_AT, onSpend: (e) => void ledger.push(e) });
    deps.openClient = (async () => ({ client, budget, account: ACCOUNT, allowance: 42, release: vi.fn() })) as unknown as ValidateDeps['openClient'];
    expect(await runValidateCli(['--max', '42'], deps)).toBe(0);
    expect(asked.filter((k) => k === 'RYOBI P553')).toHaveLength(1);
    expect(ledger).toHaveLength(6);
    expect(logs).toContain('Lookup failed (not charged, not retried): amazon  k=RYOBI P553: SerpApi returned HTTP 500.');
    expect(logs.some((l) => l.startsWith('Stopped: '))).toBe(false);
    const p553 = readResults().bundles.find((b) => b.model === 'PCL1600K2-P553')!.parts.find((p) => p.model === 'P553')!;
    expect(p553.status).toBe('waiting');
  });
});

describe('criterion 6, scored', () => {
  async function paidResults(): Promise<ValidationResults> {
    writeSet({ answers: true, kitPages: true });
    deps.cache = await cacheOf(LISTING_PHASE);
    paidClient(42);
    expect(await runValidateCli(['--max', '42'], deps)).toBe(0);
    return readResults();
  }
  const labelsFor = (results: ValidationResults, wrong: (model: string) => boolean = () => false): Labels => Object.fromEntries(results.bundles.map((b) => [
    b.model, Object.fromEntries(b.parts.map((p) => [p.model, { correct: p.asin && !wrong(p.model) ? [p.asin] : ('none' as const), note: 'test' }])),
  ]));

  it('passes when every match is one its label accepts', async () => {
    const results = await paidResults();
    const score = scoreCriterion6(results, labelsFor(results));
    expect(score.pass).toBe(true);
    expect(score.probable.total + score.confident.total).toBe(results.bundles.flatMap((b) => b.parts).filter((p) => p.status === 'matched').length);
  });

  it('fails, and names the miss, when one probable match of a few is wrong', async () => {
    const results = await paidResults();
    const probable = results.bundles.flatMap((b) => b.parts).find((p) => p.grade === 'probable')!;
    const score = scoreCriterion6(results, labelsFor(results, (m) => m === probable.model));
    expect(score.pass).toBe(false);
    expect(score.probable.wrong.map((m) => m.part)).toContain(probable.model);
    expect(scoreLines(score).some((l) => l.includes(` | ${probable.model} | probable | ${probable.asin} | none | test`))).toBe(true);
  });

  it('fails while a matched part has no label', async () => {
    const results = await paidResults();
    const score = scoreCriterion6(results, {});
    expect(score.pass).toBe(false);
    expect(score.unlabelled.length).toBeGreaterThan(0);
  });
});
