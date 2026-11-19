// npm run judge:eval: measure a listing judge against the labelled eBay listings.
//
//   --model <id>  claude-haiku-5-5 | claude-opus-5-5 (checked before anything else happens)
//   --dry-run     no network, no key read: the listings, an estimate of tokens and cost.
//   --run         reads ANTHROPIC_API_KEY (never printed), judges every labelled listing one after
//                 another with a short pause, no retries (a failed call is recorded as not judged),
//                 writes fixtures/ebay/judgements-<model>.json and scores it. Costs money: the main
//                 session runs it after the owner's yes.
//   --replay      no network: scores the existing judgements file.
//
// The judgements file holds verdicts, reasons and token counts. No key, no seller data.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EbayListing, EbayListingSummary, EbayValue } from '../core/src/ebay/types';
import {
  CLAUDE_JUDGE_MODELS, ClaudeJudge, costOf, type EvalResult, type EvalScore, JUDGE_PROMPT, judgeListing, judgeListingFromEbay, type JudgePart,
  type Label, type ListingJudge, PRICE_TABLE, type PriceRates, PROMPT_VERSION, renderJudgeInput, scoreJudgements,
} from '../core/src/judge';
import { hasModelToken, modelForms } from '../core/src/match';

/** Output tokens assumed per listing, thinking included. The estimate is only as good as this guess. */
export const ASSUMED_OUTPUT_TOKENS = 400;
export const DEFAULT_PAUSE_MS = 300;
/** Estimates divide characters by this. */
export const CHARS_PER_TOKEN = 4;

interface PartRecord { summaries: EbayListingSummary[]; kept: string[]; dropped: { itemId: string; reason: string }[]; items: Record<string, EbayListing> }
interface PartInfo { brand: string; model: string; matchedModel: string | null; title: string }

export interface JudgementsFile {
  model: string;
  promptVersion: string;
  ranAt: string;
  results: EvalResult[];
}

export interface JudgeEvalDeps {
  log: (line: string) => void;
  /** The fixtures directory. */
  dir: string;
  env: (name: string) => string | undefined;
  /** Builds the judge; tests pass a fake. */
  makeJudge?: (model: string, apiKey: string) => ListingJudge;
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: number;
  now?: () => Date;
}

interface Item { label: Label; part: JudgePart; listing: EbayListing }

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
export const judgementsPath = (dir: string, model: string): string => join(dir, 'ebay', `judgements-${model}.json`);

function loadInputs(dir: string): { items: Item[]; labels: Label[]; recording: Record<string, PartRecord>; parts: Record<string, PartInfo> } {
  const recording = readJson<{ parts: Record<string, PartRecord> }>(join(dir, 'ebay', 'validation-2026-11-19.json')).parts;
  const labels = readJson<{ labels: Label[] }>(join(dir, 'ebay', 'labels.json')).labels;
  const parts = readJson<{ prices: Record<string, PartInfo> }>(join(dir, 'validation', 'hd-part-prices-2026-11-18.json')).prices;
  const items: Item[] = labels.map((label) => {
    const listing = recording[label.model]?.items[label.itemId];
    const info = parts[label.model];
    if (!listing || !info) throw new Error(`Label ${label.model} ${label.itemId} has no recorded listing or part.`);
    const part: JudgePart = {
      brand: info.brand, model: info.model,
      ...(info.matchedModel && info.matchedModel !== info.model ? { twin: info.matchedModel } : {}),
      ...(info.title ? { title: info.title } : {}),
    };
    return { label, part, listing };
  });
  return { items, labels, recording, parts };
}

const listingsByPart = (recording: Record<string, PartRecord>): Record<string, Record<string, EbayListing>> =>
  Object.fromEntries(Object.entries(recording).map(([m, r]) => [m, r.items]));

/** Dropped "beyond the first 8" summaries that name the part's model in the title: what the cap hides. */
export function hiddenByCap(recording: Record<string, PartRecord>, parts: Record<string, PartInfo>): { hidden: number; ofCapped: number } {
  let hidden = 0, ofCapped = 0;
  for (const [model, rec] of Object.entries(recording)) {
    const info = parts[model];
    if (!info) continue;
    const forms = modelForms(info.brand, info.model);
    for (const d of rec.dropped.filter((x) => x.reason.startsWith('beyond the first'))) {
      ofCapped++;
      const s = rec.summaries.find((x) => x.itemId === d.itemId);
      if (s && forms.some((f) => hasModelToken(s.title, f))) hidden++;
    }
  }
  return { hidden, ofCapped };
}

const usd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const pct = (n: number | null): string => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);

export function printScore(log: (l: string) => void, s: EvalScore, cap: { hidden: number; ofCapped: number }): void {
  log(`Labelled listings: ${s.labelled} (${s.ownerChecked} owner-checked), ${s.labelledMatches} labelled matches.`);
  log(`Judged: ${s.judged}. Not judged: ${s.notJudged} (never counted as a verdict).`);
  log(`False matches: ${s.falseMatches.length}${s.falseMatches.length ? ' (judge match, label says otherwise)' : ''}`);
  for (const f of s.falseMatches) log(`  ${f.model}  ${f.itemId}  label ${f.label}`);
  log(`True matches accepted: ${s.trueMatchesAccepted} of ${s.labelledMatches} (recall ${pct(s.recall)}).`);
  log(`Unsure rate: ${s.unsure} of ${s.judged} (${pct(s.unsureRate)}).`);
  log(`Tokens: ${s.tokens.input} in, ${s.tokens.output} out.${s.cost === null ? '' : ` Cost: ${usd(s.cost)}.`}`);
  const changed = s.partValues.filter((p) => p.changed);
  log(`eBay value per part, judge's matches against the labels' matches: ${changed.length} of ${s.partValues.length} parts differ.`);
  const fmt = (v: EbayValue | null): string => (v ? `${v.listings} listings, ${v.unitsSold} sold, $${v.low}-$${v.high}` : 'none');
  for (const p of changed) log(`  ${p.model}: judge ${fmt(p.fromJudge)} | labels ${fmt(p.fromLabels)}`);
  log(`The cap of 8 hides ${cap.hidden} listings that name a part's model in the title (of ${cap.ofCapped} cut by the cap).`);
  log('Reliability bar (a proposal for the owner):');
  for (const r of s.reliable) log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.check}  [${r.detail}]`);
  log(s.passes ? 'Overall: PASS' : 'Overall: FAIL');
}

export async function runJudgeEval(args: string[], deps: JudgeEvalDeps): Promise<number> {
  const { log } = deps;
  const modes = new Set(['--dry-run', '--run', '--replay']);
  const mi = args.indexOf('--model');
  const model = mi >= 0 ? args[mi + 1] : undefined;
  const rest = args.filter((_, i) => i !== mi && i !== mi + 1);
  const known = (CLAUDE_JUDGE_MODELS as readonly string[]).includes(model ?? '');
  if (mi < 0 || !model || !known || rest.length !== 1 || !modes.has(rest[0]!)) {
    log('Usage: npm run judge:eval -- --model <claude-haiku-5-5|claude-opus-5-5> --dry-run | --run | --replay');
    if (model && !known) log(`Unknown model "${model}". Known: ${CLAUDE_JUDGE_MODELS.join(', ')}.`);
    return 2;
  }
  const mode = rest[0]!;
  const rates: PriceRates = PRICE_TABLE[model]!;
  let inputs;
  try { inputs = loadInputs(deps.dir); } catch (e) { log(e instanceof Error ? e.message : 'Could not read the inputs.'); return 1; }
  const cap = hiddenByCap(inputs.recording, inputs.parts);

  if (mode === '--dry-run') {
    let chars = 0;
    for (const it of inputs.items) chars += JUDGE_PROMPT.length + renderJudgeInput({ part: it.part, listing: judgeListingFromEbay(it.listing) }).length;
    const inTok = Math.ceil(chars / CHARS_PER_TOKEN);
    const outTok = inputs.items.length * ASSUMED_OUTPUT_TOKENS;
    const cost = costOf({ inputTokens: inTok, outputTokens: outTok }, rates);
    log(`Judge eval, dry run (no network, no key read). Model ${model}, prompt ${PROMPT_VERSION}.`);
    log(`Listings to judge: ${inputs.items.length} (every labelled listing), one call each.`);
    log(`Estimated input: ${inTok} tokens (rendered prompts, characters / ${CHARS_PER_TOKEN}: a rough count).`);
    log(`Estimated output: ${outTok} tokens (assumed ${ASSUMED_OUTPUT_TOKENS} a listing, thinking included).`);
    log(`Prices used: $${rates.input} in / $${rates.output} out per million tokens.`);
    log(`Estimated cost: ${usd(cost)}.`);
    log(`A run would write fixtures/ebay/judgements-${model}.json.`);
    return 0;
  }

  const file = judgementsPath(deps.dir, model);
  let results: EvalResult[];
  if (mode === '--replay') {
    if (!existsSync(file)) { log(`No judgements file for ${model}. Nothing to replay.`); return 1; }
    results = readJson<JudgementsFile>(file).results;
    log(`Judge eval, replay of fixtures/ebay/judgements-${model}.json (no network).`);
  } else {
    const key = deps.env('ANTHROPIC_API_KEY');
    if (!key) { log('ANTHROPIC_API_KEY must be set (in .env or the environment). Nothing was called.'); return 1; }
    const judge = deps.makeJudge ? deps.makeJudge(model, key) : new ClaudeJudge({ apiKey: key, model });
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pause = deps.pauseMs ?? DEFAULT_PAUSE_MS;
    results = [];
    log(`Judge eval, run. Model ${model}, ${inputs.items.length} listings, one after another.`);
    for (const it of inputs.items) {
      const out = await judgeListing(judge, { part: it.part, listing: judgeListingFromEbay(it.listing) });
      const base = { itemId: it.label.itemId, model: it.label.model };
      if (out.kind === 'judged') {
        results.push({ ...base, verdict: out.verdict, reasons: [...(out.raw?.reason ? [out.raw.reason] : []), ...out.downgrades], usage: out.usage });
      } else {
        results.push({ ...base, notJudged: { reason: out.reason, message: out.message }, reasons: [], ...(out.usage ? { usage: out.usage } : {}) });
        if (out.reason === 'auth') { log('The key was refused. Stopped; nothing written.'); return 1; }
      }
      await sleep(pause);
    }
    const doc: JudgementsFile = { model, promptVersion: PROMPT_VERSION, ranAt: (deps.now?.() ?? new Date()).toISOString(), results };
    writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
    log(`Wrote fixtures/ebay/judgements-${model}.json.`);
  }

  printScore(log, scoreJudgements({ labels: inputs.labels, results, listings: listingsByPart(inputs.recording), rates }), cap);
  return 0;
}
