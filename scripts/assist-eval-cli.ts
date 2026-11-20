// npm run assist:eval: measure the review assistant (Ask AI, step 11) against the validation set's
// answer key, on the Review questions the validation replay stores (no network for the questions).
//
//   --model <id>  claude-haiku-5-5 | claude-opus-5-5 (checked before anything else happens)
//   --dry-run     no network, no key read: the questions, their truth, an estimate of tokens and cost.
//   --run         reads ANTHROPIC_API_KEY (never printed), asks about every question one after another
//                 with a short pause, no retries (a failed call is recorded as not suggested), writes
//                 fixtures/assist/suggestions-<model>.json and scores it. Costs money: the main session
//                 runs it after the owner's yes.
//   --replay      no network: checks the answers in the suggestions file again with today's code, and
//                 scores them.
//   --max-cost <usd>  with --run: stops before the next call once the cost of the calls made reaches
//                 it, writes what it has marked incomplete, and scores only the questions asked.
//
// The questions: every split question the replay answered from the answer key, reopened (its truth is
// the key's parts), and every open match question (its truth is the checker's label for the part).
// The suggestions file holds each model call's answer text (the model's JSON: quotes from Home Depot
// and Amazon pages, its reason), or why it gave none, and token counts. No key, no eBay seller data.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ASSIST_PROMPT, ASSIST_PROMPT_VERSION, type AssistCallResult, type AssistEvalRow, type AssistEvalScore, type AssistEvidence,
  type AssistModel, type AssistTruth, ClaudeAssist, gatherEvidence, type MatchLabel, matchTruth, outcomeOf, renderAssistInput,
  scoreSuggestions, splitTruth, suggestAnswer, type Suggestion,
} from '../core/src/assist';
import { CLAUDE_JUDGE_MODELS, costOf, PRICE_TABLE, type PriceRates } from '../core/src/judge';
import { choicesOf, NONE, RESOLVED_BY_SCAN } from '../core/src/scan/answers';
import type { ReviewItem } from '../core/src/scan/types';
import { CacheOnlyClient, loadInputs, ResponsesCache, runValidationPipeline, VALIDATION_DATE, validationFiles } from './validate-cli';

/** Output tokens assumed per question, thinking included. The estimate is only as good as this guess. */
export const ASSUMED_OUTPUT_TOKENS = 400;
export const DEFAULT_PAUSE_MS = 300;
/** Estimates divide characters by this. */
export const CHARS_PER_TOKEN = 4;

export interface EvalQuestion {
  /** The question as the owner was asked it: open, no answer. */
  item: ReviewItem;
  evidence: AssistEvidence;
  /** Null when the key has nothing for it: asked, but not scored. */
  truth: AssistTruth | null;
}

/** One question of a run: the model call's result, or null when no call was made. */
export interface StoredCall {
  questionId: string;
  called: boolean;
  /** The call's result; null when no call was made, or the adapter threw. */
  result: AssistCallResult | null;
  /** The status the run's code gave it (informational: a replay checks the answer again). */
  status: Suggestion['status'];
}

export interface SuggestionsFile {
  model: string;
  promptVersion: string;
  ranAt: string;
  results: StoredCall[];
  /** Set when --max-cost stopped the run before every question was asked. */
  incomplete?: boolean;
  maxCost?: number;
}

export interface AssistEvalDeps {
  log: (line: string) => void;
  /** The fixtures directory, read: validation/. */
  dir: string;
  /** Where the suggestions files are written and read; default <dir>/assist. */
  outDir?: string;
  env: (name: string) => string | undefined;
  /** Builds the model; tests pass a fake. */
  makeModel?: (model: string, apiKey: string) => AssistModel;
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: number;
  now?: () => Date;
}

export const suggestionsPath = (outDir: string, model: string): string => join(outDir, `suggestions-${model}.json`);

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** Every label of a part model in labels-*.json, across the bundles that hold it. */
function labelsByPart(file: string): Map<string, MatchLabel[]> {
  const doc = readJson<{ labels: Record<string, Record<string, MatchLabel>> }>(file);
  const out = new Map<string, MatchLabel[]>();
  for (const parts of Object.values(doc.labels)) {
    for (const [model, label] of Object.entries(parts)) {
      const key = model.trim().toUpperCase();
      out.set(key, [...(out.get(key) ?? []), label]);
    }
  }
  return out;
}

const sameLabel = (a: MatchLabel, b: MatchLabel): boolean => JSON.stringify([a.correct, a.uncertain ?? []]) === JSON.stringify([b.correct, b.uncertain ?? []]);

/**
 * The eval's questions, from the validation replay (no network): the split questions the answer key
 * answered, reopened, and the open match questions, by id. `problems` names questions left unscored.
 */
export async function loadEvalQuestions(dir: string): Promise<{ questions: EvalQuestion[]; problems: string[] }> {
  const vdir = join(dir, 'validation');
  const files = validationFiles(vdir);
  const cache = new ResponsesCache(files.responses);
  const run = await runValidationPipeline({
    inputs: loadInputs(vdir), scanClient: new CacheOnlyClient(cache), lookupClient: new CacheOnlyClient(cache), continuePastMisses: true,
  });
  const labels = labelsByPart(files.labels);
  const problems: string[] = [];
  const questions: EvalQuestion[] = [];
  for (const stored of (await run.store.listReview()).sort((a, b) => a.id.localeCompare(b.id))) {
    let truth: AssistTruth | null;
    if (stored.kind === 'split') {
      if (stored.answer === null || stored.answer === RESOLVED_BY_SCAN) continue;
      truth = splitTruth(stored, stored.answer === NONE ? 'none' : (stored.answerParts ?? null));
      if (truth === null) problems.push(`${stored.id}: the key's answer has no parts; asked, not scored.`);
    } else {
      if (stored.answer !== null) continue;
      const found = labels.get(stored.model.trim().toUpperCase()) ?? [];
      const conflict = found.some((l) => !sameLabel(l, found[0]!));
      truth = conflict ? null : matchTruth(stored, found[0]);
      if (truth === null) problems.push(`${stored.id}: ${conflict ? 'its labels disagree' : 'no label for the part'}; asked, not scored.`);
    }
    const item: ReviewItem = { ...stored, answer: null, answerParts: null, answeredAt: null };
    questions.push({ item, evidence: await gatherEvidence(run.store, item), truth });
  }
  return { questions, problems };
}

/** Whether suggestAnswer would call the model for a question (the same rules, without calling). */
const wouldCall = (q: EvalQuestion): boolean => (q.item.kind === 'split' ? choicesOf(q.item).length > 0 : q.item.candidates.length > 0);

const usd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export function truthText(t: AssistTruth | null, item: ReviewItem): string {
  if (t === null) return 'no key';
  if (t.kind === 'none') return 'none fits';
  if (t.kind === 'uncertain') return 'uncertain (no answer is right)';
  if ('choiceIndex' in t) return `reading ${t.choiceIndex} (${choicesOf(item)[t.choiceIndex]!.join(', ')})`;
  return `listing ${t.asins.join(' or ')}`;
}

function printScore(log: (l: string) => void, s: AssistEvalScore, rows: (AssistEvalRow & { item: ReviewItem })[], rates: PriceRates): void {
  log(`Questions scored: ${s.questions}. Model calls: ${s.calls}.`);
  log(`Verified and correct: ${s.byOutcome.verified_correct}`);
  log(`Verified but wrong: ${s.byOutcome.verified_wrong} (must be 0 to trust)`);
  for (const w of s.wrong) {
    const item = rows.find((r) => r.questionId === w.questionId)!.item;
    log(`  ${w.questionId}: key ${truthText(w.truth, item)}; assistant ${w.said}`);
  }
  log(`Unverified: ${s.byOutcome.unverified}`);
  log(`Cannot tell: ${s.byOutcome.cannot_tell}`);
  log(`None fits, the AI's view (never verified, preselects nothing): ${s.byOutcome.none_suggested}, ${s.noneAgainstKey.length} where the key is not none`);
  for (const n of s.noneAgainstKey) {
    const item = rows.find((r) => r.questionId === n.questionId)!.item;
    log(`  ${n.questionId}: key ${truthText(n.truth, item)}`);
  }
  log(`Not suggested: ${s.byOutcome.not_suggested}`);
  log(`Tokens: ${s.tokens.input} in, ${s.tokens.output} out. Cost: ${usd(s.cost ?? costOf({ inputTokens: s.tokens.input, outputTokens: s.tokens.output }, rates))}.`);
  log('Per question:');
  for (const r of rows) {
    const extra = r.suggestion.status === 'unverified' ? `: ${r.suggestion.reasons.join(' ')}` : r.suggestion.status === 'not_suggested' ? `: ${r.suggestion.reason}` : '';
    log(`  ${r.questionId}  key ${truthText(r.truth, r.item)}  ${outcomeOf(r.suggestion, r.truth)}${extra}`);
  }
  log(s.trustworthy ? 'Overall: no verified suggestion disagrees with the key.' : 'Overall: FAIL, a verified suggestion disagrees with the key.');
}

/** Takes `--name <value>` out of args; undefined when absent, null when present without a value. */
function takeValue(args: string[], name: string): string | null | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined || v.startsWith('--') ? 1 : 2);
  return v === undefined || v.startsWith('--') ? null : v;
}

const USAGE = 'Usage: npm run assist:eval -- --model <claude-haiku-5-5|claude-opus-5-5> --dry-run | --run | --replay [--max-cost <usd>]';

/** A model that answers from a run's stored calls, so a replay checks the same answers with today's code. */
function replayModel(model: string, calls: Map<string, StoredCall>, questionId: () => string): AssistModel {
  return {
    provider: 'replay', model,
    ask: async () => {
      const r = calls.get(questionId())?.result;
      if (!r) throw new Error('no stored answer');
      return r;
    },
  };
}

export async function runAssistEval(args: string[], deps: AssistEvalDeps): Promise<number> {
  const { log } = deps;
  const modes = new Set(['--dry-run', '--run', '--replay']);
  const rest = [...args];
  const model = takeValue(rest, '--model');
  const maxCostArg = takeValue(rest, '--max-cost');
  const known = (CLAUDE_JUDGE_MODELS as readonly string[]).includes(model ?? '');
  const maxCost = maxCostArg == null ? undefined : /^\d+(\.\d+)?$/.test(maxCostArg) && Number(maxCostArg) > 0 ? Number(maxCostArg) : NaN;
  const badValue = maxCostArg === null || Number.isNaN(maxCost);
  if (!model || !known || rest.length !== 1 || !modes.has(rest[0]!) || badValue) {
    log(USAGE);
    if (model && !known) log(`Unknown model "${model}". Known: ${CLAUDE_JUDGE_MODELS.join(', ')}.`);
    if (badValue) log('--max-cost takes a dollar amount above 0.');
    return 2;
  }
  const mode = rest[0]!;
  const rates: PriceRates = PRICE_TABLE[model]!;
  const outDir = deps.outDir ?? join(deps.dir, 'assist');
  const file = suggestionsPath(outDir, model);
  const shown = `fixtures/assist/suggestions-${model}.json`;

  let loaded;
  try { loaded = await loadEvalQuestions(deps.dir); } catch (e) { log(e instanceof Error ? e.message : 'Could not read the inputs.'); return 1; }
  const { questions, problems } = loaded;
  const splits = questions.filter((q) => q.item.kind === 'split').length;
  const toCall = questions.filter(wouldCall);

  if (mode === '--dry-run') {
    let chars = 0;
    for (const q of toCall) chars += ASSIST_PROMPT.length + renderAssistInput(q.item, q.evidence).length;
    const inTok = Math.ceil(chars / CHARS_PER_TOKEN);
    const outTok = toCall.length * ASSUMED_OUTPUT_TOKENS;
    log(`Assist eval, dry run (no network, no key read). Model ${model}, prompt ${ASSIST_PROMPT_VERSION}, validation set ${VALIDATION_DATE}.`);
    log(`Questions: ${questions.length} (${splits} split, reopened from the answer key; ${questions.length - splits} match, open).`);
    log(`Model calls: ${toCall.length}, one each. No call for ${questions.length - toCall.length} that offer nothing to choose.`);
    for (const q of questions) log(`  ${q.item.id}  key ${truthText(q.truth, q.item)}${wouldCall(q) ? '' : '  (no call)'}`);
    for (const p of problems) log(`Note: ${p}`);
    if (maxCost !== undefined) log(`A run would stop before the next call once the cost reached ${usd(maxCost)}.`);
    log(`Estimated input: ${inTok} tokens (rendered prompts, characters / ${CHARS_PER_TOKEN}: a rough count).`);
    log(`Estimated output: ${outTok} tokens (assumed ${ASSUMED_OUTPUT_TOKENS} a question, thinking included).`);
    log(`Prices used: $${rates.input} in / $${rates.output} out per million tokens.`);
    log(`Estimated cost: ${usd(costOf({ inputTokens: inTok, outputTokens: outTok }, rates))}.`);
    log(`A run would write ${shown}.`);
    return 0;
  }

  const rows: (AssistEvalRow & { item: ReviewItem })[] = [];
  const add = (q: EvalQuestion, suggestion: Suggestion, called: boolean) => {
    if (q.truth !== null) rows.push({ questionId: q.item.id, truth: q.truth, suggestion, called, item: q.item });
  };
  let cut: { maxCost: number; done: number; of: number } | null = null;

  if (mode === '--replay') {
    if (!existsSync(file)) { log(`No suggestions file for ${model}. Nothing to replay.`); return 1; }
    const doc = readJson<SuggestionsFile>(file);
    log(`Assist eval, replay of ${shown} (no network).`);
    if (doc.promptVersion !== ASSIST_PROMPT_VERSION) {
      log(`The answers were given to prompt ${doc.promptVersion}; today's prompt is ${ASSIST_PROMPT_VERSION}. They are checked with today's code.`);
    }
    const calls = new Map(doc.results.map((r) => [r.questionId, r] as const));
    let current = '';
    const replay = replayModel(model, calls, () => current);
    for (const q of questions) {
      const stored = calls.get(q.item.id);
      if (!stored) continue; // never asked: an incomplete run
      current = q.item.id;
      add(q, await suggestAnswer(q.item, q.evidence, replay), stored.called);
    }
    if (doc.incomplete) cut = { maxCost: doc.maxCost ?? 0, done: doc.results.length, of: questions.length };
  } else {
    const apiKey = deps.env('ANTHROPIC_API_KEY');
    if (!apiKey) { log('ANTHROPIC_API_KEY must be set (in .env or the environment). Nothing was called.'); return 1; }
    const real = deps.makeModel ? deps.makeModel(model, apiKey) : new ClaudeAssist({ apiKey, model });
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pause = deps.pauseMs ?? DEFAULT_PAUSE_MS;
    const results: StoredCall[] = [];
    let spent = 0;
    log(`Assist eval, run. Model ${model}, ${questions.length} questions (${toCall.length} calls), one after another.`);
    for (const q of questions) {
      if (maxCost !== undefined && spent >= maxCost) {
        cut = { maxCost, done: results.length, of: questions.length };
        break;
      }
      let last: AssistCallResult | null = null;
      let called = false;
      const recording: AssistModel = {
        provider: real.provider, model: real.model,
        ask: async (request, signal) => {
          called = true;
          last = await real.ask(request, signal);
          return last;
        },
      };
      const suggestion = await suggestAnswer(q.item, q.evidence, recording);
      results.push({ questionId: q.item.id, called, result: last, status: suggestion.status });
      add(q, suggestion, called);
      const result = last as AssistCallResult | null;
      if (result && !result.ok && result.notJudged.reason === 'auth') { log('The key was refused. Stopped; nothing written.'); return 1; }
      if (result?.usage) spent += costOf(result.usage, rates);
      if (called) await sleep(pause);
    }
    const doc: SuggestionsFile = {
      model, promptVersion: ASSIST_PROMPT_VERSION, ranAt: (deps.now?.() ?? new Date()).toISOString(), results,
      ...(cut ? { incomplete: true, maxCost: cut.maxCost } : {}),
    };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
    log(`Wrote ${shown}.`);
  }

  for (const p of problems) log(`Note: ${p}`);
  if (cut) log(`Run cut by --max-cost ${usd(cut.maxCost)} after ${cut.done} of ${cut.of} questions: the score covers only those ${cut.done}.`);
  printScore(log, scoreSuggestions(rows, rates), rows, rates);
  return 0;
}
