// npm run listing-judge:eval: measure rung 3, the AI listing judge (core/src/listingJudge), on every recorded row with a
// known answer that rungs 0 and 1 left unknown (scripts/measure-identity.ts: the Keepa products and their labels, the
// validation search rows and their answer key). Each answer goes through the code's check before it is scored.
//
//   --model <id>      claude-haiku-5-5 | claude-sonnet-5-5 | claude-opus-5-5 (checked before anything else happens)
//   --dry-run         no network, no key read: the rows, an estimate of tokens and cost
//   --run             reads ANTHROPIC_API_KEY (never printed), one call per row, one after another, no retries (a failed
//                     call is recorded as not judged), writes fixtures/listing-judge/judgements-<model>.json, scores it.
//                     Costs money: the main session runs it.
//   --max-cost <usd>  with --run: stops before the next call once the calls made cost this much
//   --replay          no network: scores the judgements file again
//   --all             every row with a known answer, not only the ones rungs 0 and 1 left unknown
//
// Scored per row: right (ai_checked on a listing the key says is the part), wrong (ai_checked on one it says is not: the
// judge is adopted only at 0), unknown (anything else). "different" answers are counted apart: never acted on.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ClaudeProvider } from '../core/src/ai/claude';
import type { ModelProvider } from '../core/src/ai/types';
import { costOf, PRICE_TABLE, type PriceRates } from '../core/src/judge/eval';
import type { TokenUsage } from '../core/src/judge/types';
import { checkListingFields } from '../core/src/keepa/listingFields';
import {
  checkListingJudge, judgeListingWith, LISTING_JUDGE_PROMPT, LISTING_JUDGE_PROMPT_VERSION, partKind, renderListingJudgeInput,
  type ListingJudgePart, type ListingJudgeRaw,
} from '../core/src/listingJudge';
import { measureIdentity, type MeasuredRow } from './measure-identity';

export const LISTING_JUDGE_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export const ASSUMED_OUTPUT_TOKENS = 350;
export const CHARS_PER_TOKEN = 4;
const PAUSE_MS = 300;

export interface ListingJudgement {
  set: string;
  asin: string;
  model: string;
  raw?: ListingJudgeRaw;
  notJudged?: string;
  usage?: TokenUsage;
}

export interface ListingJudgementsFile {
  model: string;
  promptVersion: string;
  ranAt: string;
  results: ListingJudgement[];
  incomplete?: boolean;
  maxCost?: number;
}

export interface ListingJudgeEvalDeps {
  log: (line: string) => void;
  root: string;
  env: (name: string) => string | undefined;
  /** Builds the provider; tests pass a fake. */
  makeProvider?: (model: string, apiKey: string) => ModelProvider;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

interface Row { m: MeasuredRow; part: ListingJudgePart }

const rowKey = (r: { set: string; asin: string; model: string }): string => `${r.set}\u0000${r.asin}\u0000${r.model}`;

/** The rows to judge: a known key, and (unless `all`) left unknown by rungs 0 and 1. */
export function judgeRows(root: string, all: boolean): Row[] {
  const titles = (JSON.parse(readFileSync(join(root, 'fixtures/validation/hd-part-prices-2026-11-18.json'), 'utf8')) as { prices: Record<string, { title?: string }> }).prices;
  return measureIdentity(root).rows
    .filter((m) => m.key !== 'uncertain' && (all || checkListingFields(m.want, m.listing).status === 'unknown'))
    .map((m) => ({
      m,
      part: {
        brand: m.want.brand, model: m.want.model, kind: partKind(m.want), packQty: m.want.packQty ?? 1,
        ...(titles[m.want.model]?.title ? { title: titles[m.want.model]!.title! } : {}),
      },
    }));
}

export interface ListingJudgeScore {
  rows: number;
  judged: number;
  notJudged: number;
  right: number;
  wrong: number;
  unknown: number;
  different: number;
  /** "different" on a listing the key says is the part: harmless (never acted on), shown for the record. */
  differentButIs: number;
  cost: number;
  wrongRows: { asin: string; model: string; title: string | null; reason: string }[];
}

export function scoreListingJudge(rows: Row[], results: ListingJudgement[], rates: PriceRates): ListingJudgeScore {
  const byKey = new Map(results.map((r) => [rowKey(r), r]));
  const s: ListingJudgeScore = { rows: 0, judged: 0, notJudged: 0, right: 0, wrong: 0, unknown: 0, different: 0, differentButIs: 0, cost: 0, wrongRows: [] };
  for (const { m } of rows) {
    const r = byKey.get(rowKey({ set: m.set, asin: m.asin, model: m.model }));
    if (!r) continue;
    s.rows += 1;
    if (r.usage) s.cost += costOf(r.usage, rates);
    if (!r.raw) { s.notJudged += 1; s.unknown += 1; continue; }
    s.judged += 1;
    const out = checkListingJudge(m.want, m.listing, r.raw);
    if (out.status === 'ai_checked') {
      if (m.key === 'is') s.right += 1;
      else { s.wrong += 1; s.wrongRows.push({ asin: m.asin, model: m.model, title: m.listing.title, reason: out.reason }); }
    } else {
      s.unknown += 1;
      if (out.status === 'different') { s.different += 1; if (m.key === 'is') s.differentButIs += 1; }
    }
  }
  return s;
}

/**
 * The code's check alone, against the worst judge: one that answers "same" on every row, quoting the part's model and the
 * brand wherever the listing's title holds them. Free. Every ai_checked here on a listing the key says is not the part is
 * a wrong confirmation the code's check would let through from a careless model.
 */
export function worstCaseJudge(rows: Row[]): { right: number; wrong: number; unknown: number; wrongRows: string[] } {
  const out = { right: 0, wrong: 0, unknown: 0, wrongRows: [] as string[] };
  for (const { m } of rows) {
    const title = m.listing.title ?? '';
    const at = title.toUpperCase().indexOf(m.want.model.toUpperCase().replace(/B$/, ''));
    const token = at >= 0 ? title.slice(at).split(/[\s,()]+/)[0]! : m.want.model;
    const brandAt = title.toUpperCase().indexOf(m.want.brand.toUpperCase());
    const raw: ListingJudgeRaw = {
      quotes: [
        { about: 'model_number', field: 'title', quote: token },
        ...(brandAt >= 0 ? [{ about: 'brand' as const, field: 'title' as const, quote: title.slice(brandAt, brandAt + m.want.brand.length) }] : []),
      ],
      reason: 'worst case', verdict: 'same',
    };
    const o = checkListingJudge(m.want, m.listing, raw);
    if (o.status !== 'ai_checked') out.unknown += 1;
    else if (m.key === 'is') out.right += 1;
    else { out.wrong += 1; out.wrongRows.push(`${m.asin} for ${m.model}: ${title}`); }
  }
  return out;
}

const usd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;

function takeValue(args: string[], name: string): string | null | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined || v.startsWith('--') ? 1 : 2);
  return v === undefined || v.startsWith('--') ? null : v;
}

const USAGE = `Usage: npm run listing-judge:eval -- --model <${LISTING_JUDGE_MODELS.join('|')}> --dry-run | --run [--max-cost <usd>] | --replay [--all]`;
export const judgementsFile = (root: string, model: string): string => join(root, 'fixtures', 'listing-judge', `judgements-${model}.json`);

export async function runListingJudgeEval(args: string[], deps: ListingJudgeEvalDeps): Promise<number> {
  const { log } = deps;
  const rest = [...args];
  const model = takeValue(rest, '--model');
  const maxCostArg = takeValue(rest, '--max-cost');
  const allAt = rest.indexOf('--all');
  if (allAt >= 0) rest.splice(allAt, 1);
  const maxCost = maxCostArg == null ? undefined : /^\d+(\.\d+)?$/.test(maxCostArg) && Number(maxCostArg) > 0 ? Number(maxCostArg) : NaN;
  const known = (LISTING_JUDGE_MODELS as readonly string[]).includes(model ?? '');
  if (!model || !known || rest.length !== 1 || !['--dry-run', '--run', '--replay'].includes(rest[0]!) || maxCostArg === null || Number.isNaN(maxCost)) {
    log(USAGE);
    if (model && !known) log(`Unknown model "${model}".`);
    return 2;
  }
  const mode = rest[0]!;
  const rates = PRICE_TABLE[model]!;
  const rows = judgeRows(deps.root, allAt >= 0);
  const is = rows.filter((r) => r.m.key === 'is').length;
  const scope = allAt >= 0 ? 'every recorded row with a known answer' : 'the recorded rows with a known answer that rungs 0 and 1 left unknown';

  if (mode === '--dry-run') {
    const chars = rows.reduce((n, r) => n + LISTING_JUDGE_PROMPT.length + renderListingJudgeInput(r.part, r.m.listing).length, 0);
    const inTok = Math.ceil(chars / CHARS_PER_TOKEN);
    const outTok = rows.length * ASSUMED_OUTPUT_TOKENS;
    log(`Listing judge eval, dry run (no network, no key read). Model ${model}, prompt ${LISTING_JUDGE_PROMPT_VERSION}.`);
    log(`Rows: ${rows.length} (${scope}): ${is} the key says are the part, ${rows.length - is} it says are not. One call each.`);
    log(`Estimated input: ${inTok} tokens (characters / ${CHARS_PER_TOKEN}); output: ${outTok} tokens (assumed ${ASSUMED_OUTPUT_TOKENS} a row).`);
    log(`Prices: $${rates.input} in / $${rates.output} out per million tokens. Estimated cost: ${usd(costOf({ inputTokens: inTok, outputTokens: outTok }, rates))}.`);
    if (maxCost !== undefined) log(`A run would stop before the next call once the cost reached ${usd(maxCost)}.`);
    log(`A run would write fixtures/listing-judge/judgements-${model}.json.`);
    const w = worstCaseJudge(rows);
    log(`The code's check against a judge that says "same" on every row: ${w.right} right, ${w.wrong} wrong, ${w.unknown} unknown.`);
    for (const x of w.wrongRows) log(`  would let through: ${x}`);
    return 0;
  }

  const file = judgementsFile(deps.root, model);
  let results: ListingJudgement[];
  let cut = false;
  if (mode === '--replay') {
    if (!existsSync(file)) { log(`No judgements file for ${model}. Nothing to replay.`); return 1; }
    const doc = JSON.parse(readFileSync(file, 'utf8')) as ListingJudgementsFile;
    results = doc.results;
    cut = doc.incomplete === true;
    log(`Listing judge eval, replay of fixtures/listing-judge/judgements-${model}.json (no network), prompt ${doc.promptVersion}.`);
  } else {
    const apiKey = deps.env('ANTHROPIC_API_KEY');
    if (!apiKey) { log('ANTHROPIC_API_KEY must be set. Nothing was called.'); return 1; }
    const provider = deps.makeProvider ? deps.makeProvider(model, apiKey) : new ClaudeProvider({ apiKey, model });
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    results = [];
    let spent = 0;
    log(`Listing judge eval, run. Model ${model}, ${rows.length} rows, one after another.`);
    for (const r of rows) {
      if (maxCost !== undefined && spent >= maxCost) { cut = true; break; }
      const call = await judgeListingWith(provider, r.part, r.m.want, r.m.listing);
      const base = { set: r.m.set, asin: r.m.asin, model: r.m.model };
      results.push(call.ok ? { ...base, raw: call.raw, usage: call.usage } : { ...base, notJudged: call.problem, ...(call.usage ? { usage: call.usage } : {}) });
      if (call.usage) spent += costOf(call.usage, rates);
      if (!call.ok && /key|auth/i.test(call.problem) && results.length === 1) { log('The first call failed on the key. Stopped; nothing written.'); return 1; }
      await sleep(PAUSE_MS);
    }
    const doc: ListingJudgementsFile = {
      model, promptVersion: LISTING_JUDGE_PROMPT_VERSION, ranAt: (deps.now?.() ?? new Date()).toISOString(), results,
      ...(cut ? { incomplete: true, maxCost } : {}),
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`);
    log(`Wrote fixtures/listing-judge/judgements-${model}.json.`);
  }
  const s = scoreListingJudge(rows, results, rates);
  if (cut) log(`Run cut by --max-cost: the score covers the ${s.rows} rows judged of ${rows.length}.`);
  log(`Rows scored: ${s.rows}. Judged: ${s.judged}. Not judged: ${s.notJudged} (counted unknown).`);
  log(`After the code's check: ${s.right} right, ${s.wrong} wrong, ${s.unknown} unknown.`);
  log(`"different" answers: ${s.different} (${s.differentButIs} on a listing the key says is the part; never acted on).`);
  log(`Cost: ${usd(s.cost)}.`);
  for (const w of s.wrongRows) log(`  wrong: ${w.asin} for ${w.model}: ${w.title ?? '(no title)'} (${w.reason})`);
  log(s.wrong === 0 && s.rows > 0 ? 'Zero wrong: may be adopted (docs/decisions.md decides what ai_checked confirms).' : 'Not adopted: a wrong confirmation, or nothing scored.');
  return 0;
}
