// npm run costs -- <data folder> [--ledgers <dir>] [--at <ISO time>] [--tz <zone>]: what the services cost this month and
// the month-end forecast for each, from a data folder's ledgers (serpapi-ledger.jsonl, keepa-ledger.jsonl), its store's
// Activity runs, suggestions, settings and runtime. Read only: nothing is written, nothing reaches the network, nothing
// is spent. `--ledgers` reads the ledgers from another folder (the fixture keeps them beside the store copy); `--at`
// replays the forecast as it stood at that time.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { costsInputOf, scanHistory } from '../agent/costs';
import { defaultSettings, emptyCollection, type StoreData } from '../agent/store';
import { shortDay } from '../core/src/costs/time';
import type { CostsView } from '../core/src/costs/types';
import { parseKeepaLedger } from '../core/src/costs/usage';
import { buildCostsView } from '../core/src/costs/view';
import { amount, usd } from '../core/src/costs/words';
import { parseLedger } from '../core/src/serpapi/balance';
import { readStoreFile } from './data-folder';

export interface CostsCliIo {
  log: (line: string) => void;
  now?: () => number;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const text = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** The store's collections the costs read, filled with the defaults where a file or a field is missing. Read only. */
export function readCostsData(dir: string): Pick<StoreData, 'settings' | 'runtime' | 'suggestions' | 'activity'> {
  const d = defaultSettings();
  const raw = readStoreFile<Partial<StoreData['settings']>>(dir, 'settings.json', {});
  const settings: StoreData['settings'] = {
    ...d, ...raw,
    settings: { ...d.settings, ...(raw.settings ?? {}) },
    ai: { ...d.ai, ...(raw.ai ?? {}) },
    // A store from before step 18 has no costs: its AI cap is the AI limit (costSettingsOf), as the migration makes it.
    costs: raw.costs,
  };
  const runtime = { ...emptyCollection('runtime'), ...readStoreFile<Partial<StoreData['runtime']>>(dir, 'runtime.json', {}) };
  const suggestions = readStoreFile<StoreData['suggestions']>(dir, 'suggestions.json', []);
  const activity = { ...emptyCollection('activity'), ...readStoreFile<Partial<StoreData['activity']>>(dir, 'activity.json', {}) };
  return { settings, runtime, suggestions, activity };
}

export function costsReport(view: CostsView, extra: { scans: Record<string, { expected: number; high: number } | null> }): string[] {
  const end = shortDay(`${view.month}-${String(new Date(Date.UTC(Number(view.month.slice(0, 4)), Number(view.month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`);
  const out: string[] = [`Costs for ${view.month}, as at ${view.at}. Read from files only: no network, nothing spent.`, ''];
  for (const s of view.services) {
    const f = s.forecast;
    const price = s.monthlyPriceUsd === null ? 'price not entered' : `${usd(s.monthlyPriceUsd)} a month`;
    const plan = s.planLimit !== null ? `; plan ${amount(s.planLimit, s.unit)} a month` : '';
    out.push(`${s.label}: ${s.sentence} (${price}${plan}; state ${s.state})`);
    const by = f.basis === 'history'
      ? `about ${amount(f.expected, s.unit)} by ${end} (${amount(f.low, s.unit)} to ${amount(f.high, s.unit)})`
      : f.basis === 'settings' ? `at most ${amount(f.high, s.unit)} by ${end}` : `${amount(f.expected, s.unit)} (nothing to forecast)`;
    out.push(`  Forecast [${f.basis}, ${f.days} days, ${f.runs} scans]: ${by}${f.limitReachedOn ? `; limit reached on ${shortDay(f.limitReachedOn)}` : ''}.`);
    out.push(`  ${f.method}`);
    const scan = extra.scans[s.service];
    if (scan !== undefined) out.push(`  A scan's step, for the blocker: ${scan ? `${amount(scan.expected, s.unit)} expected, ${amount(scan.high, s.unit)} at the high end (from history)` : 'too few scans in history: its configured cap is used'}.`);
    if (s.blocked.length > 0) out.push(`  Held back this month: ${s.blocked.length} (last: ${s.blocked[s.blocked.length - 1]!.what}).`);
  }
  const t = view.total;
  out.push('', `Total: ${t.sentence}`);
  out.push(`  Spent ${usd(t.spentUsd)} (fixed ${usd(t.fixedUsd)}, metered ${usd(t.meteredUsd)}); forecast ${t.forecastUsd === null ? 'none' : `${usd(t.forecastUsd)} (${usd(t.forecastLowUsd!)} to ${usd(t.forecastHighUsd!)})`}; budget ${t.budgetUsd === null ? 'not set' : usd(t.budgetUsd)}; not counted (no price): ${t.unpriced.length ? t.unpriced.join(', ') : 'none'}.`);
  if (view.history.length > 0) out.push(`  Earlier months: ${view.history.map((h) => `${h.month} ${usd(h.totalUsd)}`).join(', ')}.`);
  return out;
}

export function runCostsCli(argv: string[], io: CostsCliIo): number {
  const dir = argv.find((a, i) => !a.startsWith('--') && !['--ledgers', '--at', '--tz'].includes(argv[i - 1] ?? ''));
  if (!dir) {
    io.log('Usage: npm run costs -- <data folder> [--ledgers <dir>] [--at <ISO time>] [--tz <zone>]');
    return 2;
  }
  const at = flag(argv, '--at');
  const now = at !== undefined ? Date.parse(at) : (io.now ?? Date.now)();
  if (!Number.isFinite(now)) {
    io.log(`--at must be a time like 2026-11-25T12:00:00Z, not "${at}".`);
    return 2;
  }
  const ledgers = flag(argv, '--ledgers') ?? dir;
  const data = readCostsData(dir);
  const input = costsInputOf(data, { serp: parseLedger(text(join(ledgers, 'serpapi-ledger.jsonl'))), keepa: parseKeepaLedger(text(join(ledgers, 'keepa-ledger.jsonl'))) }, now, flag(argv, '--tz'));
  const view = buildCostsView(input);
  const runs = data.activity.runs;
  const scans = {
    serpapi: scanHistory(runs, (r) => r.searchesUsed, now),
    keepa: scanHistory(runs, (r) => r.keepaTokensUsed, now),
    ai: scanHistory(runs, (r) => r.aiCostUsd, now),
  };
  for (const line of costsReport(view, { scans })) io.log(line);
  return 0;
}
