import { describe, expect, it } from 'vitest';

import { parseLedger, searchesLeftNow } from '../src/serpapi/balance';

// The shape of the owner's serpapi-ledger.jsonl (LedgerEntry: at, engine, key, label), Nov 23 scan 5: the account check
// at the scan's start said 97; the scan then made 17 Amazon searches. The app kept showing 97.
const CHECK = { left: 97, at: '2026-11-23T15:02:10.000Z' };
const amazon = (i: number) => ({
  at: new Date(Date.parse('2026-11-23T15:05:00.000Z') + i * 40_000).toISOString(),
  engine: 'amazon', key: `amazon|k=PART${i}`, label: `agent:lookup:PART${i}`,
});
const SCAN = Array.from({ length: 17 }, (_, i) => amazon(i));
const BEFORE = [{ at: '2026-11-20T09:00:00.000Z', engine: 'home_depot', key: 'home_depot|q=ryobi', label: 'agent:listing:ryobi' }];

describe('searchesLeftNow', () => {
  it('is the last account figure less the searches the ledger wrote after that check: 97 and 17 rows is 80', () => {
    expect(searchesLeftNow(CHECK, [...BEFORE, ...SCAN])).toBe(80);
  });

  it('counts none before the check, and all of them from a ledger the check never saw', () => {
    expect(searchesLeftNow(CHECK, BEFORE)).toBe(97);
    expect(searchesLeftNow(CHECK, [])).toBe(97);
    expect(searchesLeftNow({ left: 97, at: '2026-11-23T14:00:00.000Z' }, SCAN)).toBe(80);
  });

  it('a new account check takes over: the rows already in its figure are not taken off again', () => {
    expect(searchesLeftNow({ left: 80, at: '2026-11-23T15:20:00.000Z' }, [...BEFORE, ...SCAN])).toBe(80);
    expect(searchesLeftNow({ left: 80, at: '2026-11-23T15:20:00.000Z' }, [...SCAN, amazon(30)])).toBe(79);
  });

  it("a row at the check's own instant is part of the figure", () => {
    expect(searchesLeftNow({ left: 10, at: SCAN[0]!.at }, SCAN.slice(0, 1))).toBe(10);
  });

  it('never goes below 0, is null before any check, and counts a row whose time cannot be read', () => {
    expect(searchesLeftNow({ left: 3, at: CHECK.at }, SCAN)).toBe(0);
    expect(searchesLeftNow(null, SCAN)).toBeNull();
    expect(searchesLeftNow(undefined, [])).toBeNull();
    expect(searchesLeftNow(CHECK, [{ at: 'not a time' }])).toBe(96);
  });
});

describe('parseLedger', () => {
  it('reads the jsonl, skipping a blank or half-written line', () => {
    const text = `${[...BEFORE, ...SCAN.slice(0, 2)].map((r) => JSON.stringify(r)).join('\n')}\n\n{"at":"2026-11-23T1`;
    expect(parseLedger(text).map((r) => r.at)).toEqual([BEFORE[0]!.at, SCAN[0]!.at, SCAN[1]!.at]);
  });
});
