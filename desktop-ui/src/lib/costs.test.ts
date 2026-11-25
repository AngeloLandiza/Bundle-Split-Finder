import { describe, expect, it } from 'vitest';
import type { CostsView } from '@core/costs/types';
import { money } from './format';
import { buildCostsView, costSettingsFor, type CostsScenario } from '../api/mockCosts';
import {
  amount, chartSummary, moneySentence, totalForecast, troubleLead, troubles, costChart, costNotice, costWords, dayReadout, daysInMonth, describeChange, forecastNote, forecastWords, limitInput, limitNote, limitRange,
  mergeCostPatch, meterOf, nearestPoint, numbersTable, patchOf, readField, snap, stripBars, syncLimit, unpricedSentence, withField,
} from './costs';

const NOW = new Date(2026, 10, 14, 10, 0, 0);
const view = (s: CostsScenario, now = NOW): CostsView => buildCostsView(s, costSettingsFor(s, now), now);
const BOX = { width: 640, height: 220, margin: { top: 20, right: 76, bottom: 26, left: 44 } };

describe('the chart', () => {
  const v = view('calm');
  const g = costChart(v, BOX)!;
  it('puts day 1 at the left edge, the last day at the right edge of the plot, and today on its own day', () => {
    expect(g.monthDays).toBe(30);
    expect(g.x(1)).toBe(BOX.margin.left);
    expect(g.x(30)).toBe(BOX.width - BOX.margin.right);
    expect(g.today.day).toBe(14);
    expect(g.today.x).toBeCloseTo(g.x(14), 5);
    expect(g.points).toHaveLength(14);
  });
  it('scales dollars so a larger figure is higher (a smaller y) and zero is the baseline', () => {
    expect(g.y(0)).toBeCloseTo(BOX.height - BOX.margin.bottom, 5);
    expect(g.y(40)).toBeLessThan(g.y(20));
    expect(g.yTicks[0]!.usd).toBe(0);
    expect(g.yTicks.at(-1)!.usd).toBeGreaterThanOrEqual(v.total.budgetUsd!);
  });
  it('draws the line so far, and the dashed forecast and its wedge from today to the month end', () => {
    expect(g.solid.startsWith('M')).toBe(true);
    expect(g.solid.split('L')).toHaveLength(14);
    expect(g.dashed).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
    expect(g.dashed!.startsWith(`M${g.today.x.toFixed(1)} ${g.today.y.toFixed(1)}L${g.x(30).toFixed(1)}`)).toBe(true);
    expect(g.band!.endsWith('Z')).toBe(true);
    // The wedge's two far corners are the high and the low at the month end, high above low.
    const [hi, lo] = g.band!.replace(/Z$/, '').split('L').slice(1).map((p) => Number(p.split(' ')[1]));
    expect(hi!).toBeLessThan(lo!);
  });
  it('draws the budget as a rule across the plot at its dollar value, labelled', () => {
    expect(g.budget!.y).toBeCloseTo(g.y(v.total.budgetUsd!), 5);
    expect(g.budget!.x2 - g.budget!.x1).toBe(BOX.width - BOX.margin.left - BOX.margin.right);
    expect(g.labels.find((l) => l.key === 'budget')!.text).toBe('Budget $60');
  });
  it('labels the ends in plain dollars: so far, the forecast and its range', () => {
    expect(g.labels.find((l) => l.key === 'so-far')!.text).toBe(`$${v.total.spentUsd.toFixed(2)}`);
    expect(g.labels.find((l) => l.key === 'forecast')!.text).toMatch(/^about \$\d+/);
    expect(g.labels.find((l) => l.key === 'range')!.text).toMatch(/^\$\d+ to \$\d+$/);
    expect(g.xTicks.map((t) => t.label)).toEqual(['Nov 1', 'Nov 16', 'Nov 30']);
  });
  it('has no budget rule when none is set, and no forecast when the agent gave none', () => {
    const none: CostsView = { ...v, total: { ...v.total, budgetUsd: null, forecastUsd: null, forecastLowUsd: null, forecastHighUsd: null } };
    const h = costChart(none, BOX)!;
    expect(h.budget).toBeNull();
    expect(h.dashed).toBeNull();
    expect(h.band).toBeNull();
  });
  it('on the first day draws a dot (no line) and still the forecast', () => {
    const first = view('calm', new Date(2026, 10, 1, 9));
    const h = costChart(first, BOX)!;
    expect(h.points).toHaveLength(1);
    expect(h.solid).toBe('');
    expect(h.dashed).not.toBeNull();
    expect(h.today.x).toBe(BOX.margin.left);
  });
  it('draws no forecast on the last day of the month, and nothing when there are no days', () => {
    expect(costChart(view('calm', new Date(2026, 10, 30, 9)), BOX)!.dashed).toBeNull();
    expect(costChart({ ...v, days: [] }, BOX)).toBeNull();
  });
  it('finds the day nearest the pointer', () => {
    expect(nearestPoint(g, g.x(1) - 50)).toBe(0);
    expect(nearestPoint(g, g.x(7) + 1)).toBe(6);
    expect(nearestPoint(g, 10_000)).toBe(13);
  });
});

describe('the words around the chart', () => {
  const v = view('calm');
  it('states the three figures as the chart’s text alternative', () => {
    const t = chartSummary(v);
    expect(t).toContain(`${v.total.spentUsd.toFixed(2)} so far on Nov 14`);
    expect(t).toMatch(/Expected about \$\d+ by the end of the month, between \$\d+ and \$\d+\./);
    expect(t).toContain('Your total budget is $60.00.');
    expect(chartSummary({ ...v, total: { ...v.total, forecastUsd: null, budgetUsd: null } })).toContain('There is no forecast yet. No total budget is set.');
  });
  it('reads a day by service for hover and focus', () => {
    const t = dayReadout(v, 2);
    expect(t).toMatch(/^Nov 3: \$[\d.]+ that day \(SerpApi \$0\.00, Keepa \$0\.00, AI \(Anthropic\) \$[\d.]+\); \$[\d.]+ so far this month\.$/);
    expect(dayReadout(v, 99)).toBe('');
  });
  it('gives the same numbers as a table: a row a day, a column a service, then the forecast and budget', () => {
    const t = numbersTable(v);
    expect(t.head).toEqual(['Day', 'SerpApi', 'Keepa', 'AI (Anthropic)', 'That day', 'So far']);
    expect(t.rows).toHaveLength(14);
    expect(t.rows[0]![0]).toBe('Nov 1');
    expect(t.rows.at(-1)!.at(-1)).toBe(`$${v.total.spentUsd.toFixed(2)}`);
    expect(t.lines[0]).toMatch(/^Month end, expected: \$[\d.]+, between \$[\d.]+ and \$[\d.]+\.$/);
    expect(t.lines).toContain('Total budget: $60.00.');
  });
  it('says how the forecast was made and that it is an estimate; with no history it says it rests on settings', () => {
    expect(forecastNote(v)).toMatch(/Resampled from your own days and runs/);
    expect(forecastNote(v)).toMatch(/estimate, not a bill\.$/);
    expect(forecastNote(view('no-history'))).toMatch(/^Too little history, so this is the most your/);
    // The owner's real screen (Nov 25): three services on settings, each method opening the same way. The note is the
    // dollar service's method once, not all three joined.
    const real = (m: string) => `Only 2 days of history (7 are needed, and 5 scans to forecast from it), so this is the most your settings allow by month's end: ${m}`;
    const three = { ...view('no-history') };
    three.services = three.services.map((s) => ({ ...s, forecast: { ...s.forecast, basis: 'settings' as const, method: real(s.unit === 'usd' ? 'your $25.00 AI limit.' : s.unit === 'tokens' ? 'Keepa refills 1 token a minute, 1,440 a day.' : '18 searches for each of the 6 scheduled scans left.') } }));
    expect(forecastNote(three)).toBe(`${real('your $25.00 AI limit.')} It is a bound, not a bill.`);
    expect(forecastNote(view('no-history'))).toMatch(/It is a bound, not a bill\.$/);
    const nothing = { ...v, services: v.services.map((s) => ({ ...s, forecast: { ...s.forecast, basis: 'none' as const } })) };
    expect(forecastNote(nothing)).toMatch(/^No forecast yet/);
  });
  it('says plainly which price is missing and that it is not in the totals', () => {
    expect(unpricedSentence(view('unpriced'))).toBe('Keepa’s monthly price is not entered, so it is not in these totals.');
    expect(unpricedSentence(v)).toBeNull();
    const both = { ...v, total: { ...v.total, unpriced: ['serpapi', 'keepa'] as CostsView['total']['unpriced'] } };
    expect(unpricedSentence(both)).toBe('SerpApi and Keepa: their monthly prices are not entered, so they are not in these totals.');
  });
});

describe('each service in its own unit', () => {
  it('writes the forecast with the limit and the range in searches, tokens and dollars', () => {
    const v = view('calm');
    const serp = v.services.find((s) => s.service === 'serpapi')!;
    expect(forecastWords(serp)).toMatch(/^about \d+ of \d+ searches; between \d+ and \d+$/);
    const ai = v.services.find((s) => s.service === 'ai')!;
    expect(forecastWords(ai)).toMatch(/^about \$[\d.]+ of \$25; between \$[\d.]+ and \$[\d.]+$/);
    expect(forecastWords({ ...serp, limit: null, planLimit: null })).toMatch(/^about \d+ searches; between/);
  });
  it('says when the forecast rests on settings or there is nothing to forecast', () => {
    const serp = view('no-history').services[0]!;
    // A bound, not a prediction, and no range: there is none.
    expect(forecastWords(serp)).toBe('at most about 96 of 150 searches at your current schedule and limits');
    expect(forecastWords({ ...serp, forecast: { ...serp.forecast, basis: 'none' } })).toMatch(/^Nothing to forecast/);
  });
  it('says what each costs: free plan, price not entered, metered so far', () => {
    const v = view('unpriced');
    const by = (k: string) => v.services.find((s) => s.service === k)!;
    expect(costWords(by('serpapi'))).toEqual({ text: '$0.00 a month: free plan', missing: false });
    expect(costWords(by('keepa'))).toEqual({ text: 'Price not entered', missing: true });
    expect(costWords(by('ai')).text).toMatch(/^\$[\d.]+ so far, about \$[\d.]+ by month end$/);
    expect(costWords(by('ebay'))).toEqual({ text: 'Free', missing: false });
    expect(costWords(view('calm').services[1]!)).toEqual({ text: '$19.00 a month', missing: false });
  });
  it('puts the warn mark on the meter as a share of the limit, and none where there is no limit at all', () => {
    const serp = view('calm').services[0]!;
    expect(meterOf(serp, 80)).toEqual({ value: serp.used, max: serp.limit!, warnAt: 0.8 });
    expect(meterOf({ ...serp, limit: null }, 80)!.max).toBe(250);
    expect(meterOf({ ...serp, limit: null, planLimit: null }, 80)).toBeNull();
  });
  it('draws a bar a day with the tallest filling the height, and gaps for days with no use', () => {
    const days = [
      { date: '2026-11-01', used: 2, usd: 0 },
      { date: '2026-11-02', used: 0, usd: 0 },
      { date: '2026-11-03', used: 8, usd: 0 },
    ];
    const s = stripBars(days, 30, 150, 20);
    expect(s.bars.map((b) => [b.date, b.height])).toEqual([['2026-11-01', 5], ['2026-11-03', 20]]);
    expect(s.bars[1]!.x).toBe(10);
    expect(s.peak).toEqual({ used: 8, date: '2026-11-03' });
    expect(stripBars([], 30, 150, 20)).toEqual({ bars: [], peak: null });
  });
});

describe('the slider and its number are one value', () => {
  const v = view('calm');
  it('gives each service a range that fits it', () => {
    expect(limitRange('serpapi', v)).toEqual({ min: 0, max: 250, step: 5 });
    expect(limitRange('ai', v)).toEqual({ min: 0, max: 100, step: 1 });
    const keepa = limitRange('keepa', v);
    expect(keepa.max).toBe(864_000);
    expect(keepa.step).toBe(10_000);
    const total = limitRange('total', v);
    expect(total.step).toBe(5);
    expect(total.max).toBeGreaterThanOrEqual(200);
  });
  it('stretches the range for a saved value above its end instead of lying about it', () => {
    const big = { ...v, settings: { ...v.settings, services: { ...v.settings.services, ai: { ...v.settings.services.ai, monthlyLimit: 140 } } } };
    expect(limitRange('ai', big).max).toBe(140);
  });
  it('moving the slider sets the number; typing sets the slider', () => {
    const r = limitRange('serpapi', v);
    expect(syncLimit({ by: 'slider', value: 117 }, r, 'searches')).toEqual({ value: 115, text: '115', thumb: 115, error: null });
    expect(syncLimit({ by: 'field', text: '120' }, r, 'searches')).toEqual({ value: 120, text: '120', thumb: 120, error: null });
    // The field may hold a figure the step skips: the slider sits at the nearest place, the value stays what was typed.
    expect(syncLimit({ by: 'field', text: '123' }, r, 'searches').value).toBe(123);
  });
  it('pegs the slider at its end for a typed figure beyond it, and keeps the figure', () => {
    const r = limitRange('serpapi', v);
    const x = syncLimit({ by: 'field', text: '900' }, r, 'searches');
    expect(x.value).toBe(900);
    expect(x.thumb).toBe(250);
  });
  it('refuses what is not a number, a negative, or empty, with a sentence, and saves nothing', () => {
    const r = limitRange('ai', v);
    expect(syncLimit({ by: 'field', text: '' }, r, 'usd')).toMatchObject({ value: null, error: 'Enter a number, or choose No limit.' });
    expect(syncLimit({ by: 'field', text: 'abc' }, r, 'usd')).toMatchObject({ value: null, error: 'Enter a number.' });
    expect(syncLimit({ by: 'field', text: '-3' }, r, 'usd')).toMatchObject({ value: null, error: 'A limit cannot be below 0.' });
  });
  it('rounds counts to whole numbers and dollars to the cent', () => {
    expect(limitInput('12.6', 'searches')).toEqual({ ok: true, value: 13 });
    expect(limitInput('12.456', 'usd')).toEqual({ ok: true, value: 12.46 });
  });
  it('snaps to a step inside the range', () => {
    expect(snap(262, { min: 0, max: 250, step: 5 })).toBe(250);
    expect(snap(-4, { min: 0, max: 250, step: 5 })).toBe(0);
    expect(snap(12.5, { min: 0, max: 100, step: 1 })).toBe(13);
  });
  it('says what a limit below the use already made means', () => {
    const serp = view('calm').services[0]!;
    expect(limitNote(serp, 10, true)).toBe(`Already at ${amount(serp.used, 'searches')}; nothing more will be spent this month.`);
    expect(limitNote(serp, 10, false)).toMatch(/^Already at .* Holding back is off, so you are warned but nothing is stopped\.$/);
    expect(limitNote(serp, null, true)).toBe('The plan’s own limit of 250 searches still holds.');
    expect(limitNote(serp, 100_000, true)).toBeNull();
    const over = { ...serp, forecast: { ...serp.forecast, expected: serp.used * 2 } };
    expect(limitNote(over, Math.round(serp.used * 1.5), true)).toMatch(/expected by month end, so some steps will be held back\.$/);
  });
});

describe('a change to a setting: its patch, its words, its undo', () => {
  const v = view('calm');
  const s = v.settings;
  it('builds only what changed, and null clears', () => {
    expect(patchOf({ kind: 'limit', service: 'serpapi' }, 120)).toEqual({ services: { serpapi: { monthlyLimit: 120 } } });
    expect(patchOf({ kind: 'limit', service: 'ai' }, null)).toEqual({ services: { ai: { monthlyLimit: null } } });
    expect(patchOf({ kind: 'total' }, 80)).toEqual({ totalMonthlyUsd: 80 });
    expect(patchOf({ kind: 'block' }, false)).toEqual({ blockWhenOver: false });
    expect(patchOf({ kind: 'price', service: 'keepa' }, null)).toEqual({ services: { keepa: { monthlyPriceUsd: null } } });
  });
  it('reads and writes one field without touching the others', () => {
    const f = { kind: 'warn', service: 'keepa' } as const;
    expect(readField(s, f)).toBe(80);
    const next = withField(s, f, 90);
    expect(readField(next, f)).toBe(90);
    expect(readField(s, f)).toBe(80);
    expect(next.services.serpapi).toEqual(s.services.serpapi);
  });
  it('undoes by writing the value back: the before of a change is its undo patch', () => {
    const f = { kind: 'limit', service: 'serpapi' } as const;
    const before = readField(s, f);
    const changed = withField(s, f, 40);
    expect(readField(withField(changed, f, before), f)).toBe(before);
    expect(patchOf(f, before)).toEqual({ services: { serpapi: { monthlyLimit: before } } });
  });
  it('merges two patches in one save', () => {
    const a = patchOf({ kind: 'limit', service: 'serpapi' }, 100);
    const b = mergeCostPatch(a, patchOf({ kind: 'warn', service: 'serpapi' }, 90));
    expect(b).toEqual({ services: { serpapi: { monthlyLimit: 100, warnAtPercent: 90 } } });
    expect(mergeCostPatch(b, { totalMonthlyUsd: null })).toEqual({ totalMonthlyUsd: null, services: { serpapi: { monthlyLimit: 100, warnAtPercent: 90 } } });
  });
  it('says what changed in a sentence', () => {
    expect(describeChange({ kind: 'limit', service: 'serpapi' }, 150, 120, v)).toBe('SerpApi limit changed from 150 searches to 120 searches.');
    expect(describeChange({ kind: 'limit', service: 'ai' }, 25, null, v)).toBe('AI (Anthropic) limit changed from $25.00 to no limit.');
    expect(describeChange({ kind: 'price', service: 'keepa' }, null, 19, v)).toBe('Keepa price changed from not entered to $19.00 a month.');
    expect(describeChange({ kind: 'total' }, 60, 80, v)).toBe('Total budget changed from $60.00 to $80.00.');
    expect(describeChange({ kind: 'block' }, true, false, v)).toBe('Steps expected to pass a limit will run; you are warned instead.');
  });
});

describe('which state becomes a notice', () => {
  it('says nothing for a calm month', () => {
    expect(costNotice(view('calm'))).toBeNull();
    expect(costNotice(null)).toBeNull();
  });
  it('approaching is quiet; expected over, over and held back need him', () => {
    const a = costNotice(view('approaching'))!;
    expect(a).toMatchObject({ state: 'approaching', tone: 'quiet', service: 'serpapi', title: 'SerpApi is nearing its limit.' });
    const e = costNotice(view('expected-over'))!;
    expect(e).toMatchObject({ state: 'expected_over', tone: 'attention', service: 'serpapi' });
    expect(e.title).toMatch(/^SerpApi is expected to (reach its limit on Nov \d+|pass its limit this month)\.$/);
    const b = costNotice(view('blocked'))!;
    expect(b).toMatchObject({ state: 'blocked', tone: 'attention', service: 'ai', title: 'AI (Anthropic): something was held back.' });
    expect(b.body).toMatch(/^Review cards\. It was expected to use about \$0\.40 and \$0\.31 of your \$[\d.]+ is left\.$/);
  });
  it('shows the worst one: held back over over over expected over approaching', () => {
    const v = view('approaching');
    const serp = v.services[0]!;
    const worse: CostsView = { ...v, services: v.services.map((s) => (s.service === 'ai' ? { ...s, state: 'over' as const } : s)) };
    expect(costNotice(worse)!.state).toBe('over');
    expect(costNotice(worse)!.title).toBe('AI (Anthropic) is at its limit.');
    const blocked: CostsView = { ...worse, services: worse.services.map((s) => (s.service === 'keepa' ? { ...s, state: 'blocked' as const, blocked: [{ what: 'Lookups', why: 'Too many.', at: '' }] } : s)) };
    expect(costNotice(blocked)!.state).toBe('blocked');
    expect(serp.state).toBe('approaching');
  });
  it('speaks for the total budget when that is what is worst', () => {
    const v = view('calm');
    const n = costNotice({ ...v, total: { ...v.total, state: 'expected_over', forecastUsd: 75, forecastLowUsd: 70, forecastHighUsd: 80 } })!;
    expect(n).toMatchObject({ service: null, tone: 'attention', title: 'The month is expected to pass your budget.' });
    expect(n.body).toBe(`${money(v.total.spentUsd)} so far this month; expected about $75 by Nov 30 (between $70 and $80), over your $60 total.`);
  });
});

describe('the mock agent’s views are the real shape', () => {
  it('moves the states with the settings, like the agent: a limit below the use is over, back above is fine', () => {
    const now = NOW;
    const s = costSettingsFor('calm', now);
    expect(buildCostsView('calm', s, now).services[0]!.state).toBe('ok');
    const low = withField(s, { kind: 'limit', service: 'serpapi' }, 10);
    const over = buildCostsView('calm', low, now).services[0]!;
    expect(over.state).toBe('over');
    expect(over.sentence).toMatch(/^At your limit: /);
  });
  it('a month’s first day has one day, the last day a whole month', () => {
    expect(view('calm', new Date(2026, 10, 1)).days).toHaveLength(1);
    expect(view('calm', new Date(2026, 10, 30)).days).toHaveLength(30);
    expect(daysInMonth('2026-02')).toBe(28);
  });
  it('the sums are the sums: the total spent is fixed plus metered, and the last day’s cumulative is the total', () => {
    const v = view('calm');
    expect(v.total.spentUsd).toBeCloseTo(v.total.fixedUsd + v.total.meteredUsd, 2);
    expect(v.days.at(-1)!.cumulativeUsd).toBeCloseTo(v.total.spentUsd, 2);
  });
});

describe('a range is only a range when its ends differ, and a bound is worded as one', () => {
  const calm = view('calm');
  it('says "about $30" with no range when low and high round to the same figure', () => {
    const same: CostsView = { ...calm, total: { ...calm.total, forecastUsd: 30.1, forecastLowUsd: 29.8, forecastHighUsd: 30.4 } };
    expect(totalForecast(same)).toEqual({ mid: 30.1, bound: false, range: null });
    expect(moneySentence(same)).toBe(`${money(same.total.spentUsd)} so far this month; expected about $30 by Nov 30, inside your $60 total.`);
    expect(chartSummary(same)).toContain('Expected about $30 by the end of the month.');
    const g = costChart(same, BOX)!;
    expect(g.band).toBeNull();
    expect(g.labels.find((l) => l.key === 'range')).toBeUndefined();
    expect(g.labels.find((l) => l.key === 'forecast')!.text).toBe('about $30');
  });
  it('keeps the range when the ends differ', () => {
    expect(totalForecast(calm)!.range).not.toBeNull();
    expect(moneySentence(calm)).toMatch(/expected about \$\d+ by Nov 30 \(between \$\d+ and \$\d+\), inside your \$60 total\.$/);
  });
  it('a service range with one figure at both ends has no "between"', () => {
    const serp = calm.services[0]!;
    expect(forecastWords({ ...serp, forecast: { ...serp.forecast, expected: 120, low: 120, high: 120.4 } })).toBe(`about 120 of ${serp.limit} searches`);
  });
  it('words a forecast that rests on settings as a bound, in the headline, the chart and the summary', () => {
    const none = view('no-history');
    expect(totalForecast(none)!.bound).toBe(true);
    expect(totalForecast(none)!.range).toBeNull();
    expect(moneySentence(none)).toMatch(/^\$19\.00 so far this month; at most about \$\d+ by Nov 30 at your current schedule and limits, inside your \$60 total\.$/);
    expect(moneySentence(none)).not.toContain('between');
    expect(chartSummary(none)).toMatch(/At most about \$\d+ by the end of the month at your current schedule and limits\./);
    expect(costChart(none, BOX)!.labels.find((l) => l.key === 'forecast')!.text).toMatch(/^at most \$\d+/);
  });
  it('says over your total when the forecast passes it, and says so when no budget is set', () => {
    expect(moneySentence({ ...calm, total: { ...calm.total, budgetUsd: 20 } })).toMatch(/, over your \$20 total\.$/);
    expect(moneySentence({ ...calm, total: { ...calm.total, budgetUsd: null } })).toMatch(/, and no total budget is set\.$/);
  });
});

describe('the headline leads with the worst service', () => {
  it('says nothing about trouble in a calm month, and lists nothing', () => {
    expect(troubleLead(view('calm'))).toBeNull();
    expect(troubles(view('calm'))).toEqual([]);
  });
  it('blocked: names the service and its share of the limit, and what was held back', () => {
    const v = view('blocked');
    expect(troubleLead(v)).toMatch(/^AI is at \d+% of its limit\. Held back: Review cards\.$/);
    const list = troubles(v);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ service: 'ai', state: 'blocked', heldBack: 'Held back: Review cards.' });
    expect(list[0]!.sentence).toMatch(/^Held back to stay inside your limit/);
  });
  it('expected over: names the day the limit is reached', () => {
    const v = view('expected-over');
    expect(troubleLead(v)).toMatch(/^SerpApi is expected to (reach its limit on Nov \d+|pass its limit this month)\.$/);
    expect(troubles(v).map((t) => t.service)).toEqual(['serpapi']);
  });
  it('approaching and over', () => {
    expect(troubleLead(view('approaching'))).toMatch(/^SerpApi is nearing its limit \(\d+%\)\.$/);
    const s = costSettingsFor('calm', NOW);
    const over = buildCostsView('calm', withField(s, { kind: 'limit', service: 'serpapi' }, 10), NOW);
    expect(troubleLead(over)).toBe('SerpApi is at its limit.');
  });
  it('lists every service that is not fine, worst first, and counts the others in the lead', () => {
    const v = view('approaching');
    const two: CostsView = { ...v, services: v.services.map((s) => (s.service === 'ai' ? { ...s, state: 'over' as const } : s)) };
    expect(troubles(two).map((t) => t.service)).toEqual(['ai', 'serpapi']);
    expect(troubleLead(two)).toBe('AI is at its limit. 1 other service needs a look.');
  });
});

describe('every state of the view becomes the right notice, or none', () => {
  const states = ['ok', 'approaching', 'expected_over', 'over', 'blocked'] as const;
  const withService = (v: CostsView, state: (typeof states)[number]): CostsView => ({
    ...v,
    services: v.services.map((s) => (s.service === 'serpapi' ? { ...s, state, blocked: state === 'blocked' ? [{ what: 'Lookups', why: 'Over the limit.', at: '' }] : [] } : s)),
  });
  it('one service in each state', () => {
    const v = view('calm');
    expect(costNotice(withService(v, 'ok'))).toBeNull();
    expect(costNotice(withService(v, 'approaching'))).toMatchObject({ state: 'approaching', tone: 'quiet', service: 'serpapi' });
    expect(costNotice(withService(v, 'expected_over'))).toMatchObject({ state: 'expected_over', tone: 'attention', service: 'serpapi' });
    expect(costNotice(withService(v, 'over'))).toMatchObject({ state: 'over', tone: 'attention', service: 'serpapi', title: 'SerpApi is at its limit.' });
    expect(costNotice(withService(v, 'blocked'))).toMatchObject({ state: 'blocked', tone: 'attention', service: 'serpapi', body: 'Lookups. Over the limit.' });
  });
  it('the total in each state, when every service is fine', () => {
    const v = view('calm');
    const by = (state: (typeof states)[number]) => costNotice({ ...v, total: { ...v.total, state } });
    expect(by('ok')).toBeNull();
    expect(by('approaching')).toMatchObject({ state: 'approaching', tone: 'quiet', service: null, title: 'The month is nearing your budget.' });
    expect(by('expected_over')).toMatchObject({ state: 'expected_over', tone: 'attention', service: null });
    expect(by('over')).toMatchObject({ state: 'over', tone: 'attention', service: null, title: 'The month is over your budget.' });
    expect(by('blocked')).toMatchObject({ state: 'blocked', service: null });
  });
  it('each mock month gives the notice its screen shows', () => {
    expect(costNotice(view('calm'))).toBeNull();
    expect(costNotice(view('unpriced'))).toBeNull();
    expect(costNotice(view('no-history'))).toBeNull();
    expect(costNotice(view('approaching'))!.state).toBe('approaching');
    expect(costNotice(view('expected-over'))!.state).toBe('expected_over');
    expect(costNotice(view('blocked'))!.state).toBe('blocked');
  });
});
