import { describe, expect, it } from 'vitest';
import type { AppState, DealRow, ReviewQuestion } from '../api/types';
import { actionItems, dealItems, flatten, goToItems, itemScore, questionItems, rank, wordScore, type PaletteItem } from './palette';

const state = (over: { status?: AppState['agent']['status']; keys?: Partial<AppState['keys']> } = {}): AppState => ({
  agent: { status: over.status ?? 'idle', pipeline: null, step: null, nextScanAt: null, lastScan: null },
  helper: { paired: true, connected: true, lastSeenAt: null, jobsWaiting: 0 },
  budget: { serpLeft: 100, serpMonthly: 250, serpReserve: 20, serpPerScan: 5, keepaTokens: null, aiSpentUsd: 0, aiCapUsd: 20 },
  counts: { review: 0, autopilotApplied: 0, newDeals: 0 },
  keys: { serpapi: true, keepa: false, anthropic: true, openai: false, ebay: false, telegram: false, ...over.keys },
  firstRun: false,
});

const deal = (id: string, model: string, title: string, itemId: string | null = null): DealRow =>
  ({ id, title, brand: 'RYOBI', model, itemId, link: null, section: 'confirmed', price: 100, off: 10, matchState: null, profit: 10, roi: 0.1, roiRange: null, needsAnswer: false, updatedAt: '2026-11-22T00:00:00Z', lookup: null }) as DealRow;

const titles = (items: PaletteItem[]) => items.map((i) => i.title);

describe('the words of a query', () => {
  it('ranks a whole word above a word start above the middle of a word above letters in order', () => {
    const whole = wordScore('saw', 'circular saw kit')!;
    const start = wordScore('saw', 'sawzall kit')!;
    const middle = wordScore('saw', 'jigsaw kit')!;
    const fuzzy = wordScore('pc2200', 'pcl2200k3n')!;
    expect(whole).toBeGreaterThan(start);
    expect(start).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(fuzzy);
  });
  it('does not match letters scattered across a long text', () => {
    expect(wordScore('dxz', 'dewalt 20v max combo kit with batteries and charger')).toBeNull();
    expect(wordScore('qq', 'pcl1600k2')).toBeNull();
    expect(wordScore('pcl12', 'pcl1600k2')).toBeNull();
  });
  it('needs every word to fit somewhere', () => {
    const item = { title: 'ONE+ 18V Cordless 6-Tool Combo Kit', detail: 'RYOBI · PCL1600K2', keywords: 'PCL1600K2 RYOBI 317987591' };
    expect(itemScore('ryobi combo', item)).not.toBeNull();
    expect(itemScore('ryobi dewalt', item)).toBeNull();
    expect(itemScore('317987591', item)).not.toBeNull();
    expect(itemScore('', item)).toBe(0);
  });
});

describe('the palette list', () => {
  const rows = [
    deal('hd-1', 'PCL1600K2', 'ONE+ 18V Cordless 6-Tool Combo Kit', '317987591'),
    deal('hd-2', 'PCL1200K2', 'ONE+ 18V Cordless 2-Tool Combo Kit', '317987595'),
    deal('hd-3', 'DCK240C2', '20V MAX Cordless Drill/Impact 2 Tool Combo Kit'),
  ];
  const all = [...goToItems(true), ...actionItems({ state: state(), askable: 2, verified: 3, deals: 3 }), ...dealItems(rows)];

  it('shows the screens, the Deals views and the actions when nothing is typed, and not the deals or the panes', () => {
    const groups = rank(all, '');
    expect(groups.map((g) => g.section)).toEqual(['Go to', 'Actions']);
    expect(titles(groups[0]!.items)).toEqual(['Today', 'Deals', 'Deals · Confirmed', 'Deals · Needs an answer', 'Deals · Waiting for a lookup', 'Deals · Losing money', 'Review', 'Activity', 'Settings']);
  });

  it('shows the Preferences panes once a word names them', () => {
    const settings = rank(all, 'fees')[0]!;
    expect(settings.section).toBe('Go to');
    expect(settings.items[0]!.title).toBe('Settings · Fees');
  });

  it('finds a deal by model, by item number, and by title', () => {
    expect(titles(flatten(rank(all, 'pcl1200')))).toContain('ONE+ 18V Cordless 2-Tool Combo Kit');
    expect(titles(flatten(rank(all, '317987591')).filter((i) => i.section === 'Deals'))).toEqual(['ONE+ 18V Cordless 6-Tool Combo Kit']);
    const byTitle = rank(all, 'drill impact').find((g) => g.section === 'Deals')!;
    expect(titles(byTitle.items)).toEqual(['20V MAX Cordless Drill/Impact 2 Tool Combo Kit']);
  });

  it('puts the better match first and keeps the sections in order', () => {
    const groups = rank(all, 'scan');
    expect(groups.map((g) => g.section)).toEqual(['Go to', 'Actions']);
    expect(titles(groups[0]!.items)).toContain('Settings · Scanning');
    expect(groups[1]!.items[0]!.title).toBe('Scan now');
  });

  it('says nothing for a query nothing fits', () => {
    expect(rank(all, 'zzzzqx')).toEqual([]);
  });

  it('walks the groups as one list for the arrow keys', () => {
    const flat = flatten(rank(all, 'combo'));
    expect(flat.every((i) => i.section === 'Deals' || i.section === 'Go to' || i.section === 'Actions')).toBe(true);
    expect(flat.filter((i) => i.section === 'Deals')).toHaveLength(3);
  });

  it('lists a question by its bundle and its model', () => {
    const q = { id: 'q1', kind: 'match', bundle: { id: 'hd-1', title: 'Combo Kit', brand: 'RYOBI', model: 'PCL1600K2', link: null }, subject: 'PCL660B', prompt: 'Which listing is the flashlight?' } as ReviewQuestion;
    const items = questionItems([q]);
    expect(titles(flatten(rank(items, 'pcl660')))).toEqual(['Combo Kit']);
    expect(items[0]!.detail).toBe('Which listing · PCL660B');
  });
});

describe('the actions he may run', () => {
  const ids = (items: PaletteItem[]) => items.map((i) => i.id.replace('cmd:', ''));
  it('offers Scan now with its cost and Pause when the agent is idle', () => {
    const items = actionItems({ state: state(), askable: 0, verified: 0, deals: 0 });
    expect(ids(items)).toEqual(['scan', 'pause']);
    expect(items[0]!.hint).toBe('5 searches');
  });
  it('offers Stop, not Scan now, while a scan runs; and Resume while paused', () => {
    expect(ids(actionItems({ state: state({ status: 'scanning' }), askable: 2, verified: 0, deals: 1 }))).toEqual(['stop', 'pause', 'csv']);
    expect(ids(actionItems({ state: state({ status: 'paused' }), askable: 0, verified: 0, deals: 0 }))).toEqual(['scan', 'resume']);
  });
  it('leaves Scan now out without a SerpApi key, and Ask AI out without a model key or without questions', () => {
    expect(ids(actionItems({ state: state({ keys: { serpapi: false } }), askable: 3, verified: 0, deals: 0 }))).toEqual(['pause', 'ask-all']);
    expect(ids(actionItems({ state: state({ keys: { anthropic: false } }), askable: 3, verified: 0, deals: 0 }))).toEqual(['scan', 'pause']);
    expect(ids(actionItems({ state: state(), askable: 0, verified: 0, deals: 0 }))).not.toContain('ask-all');
  });
  it('asks before approving the verified answers, and says how many', () => {
    const approve = actionItems({ state: state(), askable: 0, verified: 3, deals: 0 }).find((i) => i.id === 'cmd:approve-all')!;
    expect(approve.title).toBe('Approve all 3 verified');
    expect(approve.confirm).toBe('Approve 3 verified AI answers? Each is applied as your answer.');
    expect(actionItems({ state: state(), askable: 0, verified: 0, deals: 0 }).some((i) => i.id === 'cmd:approve-all')).toBe(false);
  });
  it('has nothing to run before the agent has answered', () => {
    expect(actionItems({ state: null, askable: 0, verified: 0, deals: 0 })).toEqual([]);
  });
});
