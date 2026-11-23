// npm run research:eval: measure the research agent (step 12) against the validation set's answer key,
// on the split questions the validation replay stores, with tools that answer ONLY from recorded files
// (scripts/research-tools.ts: fixtures/research/tools/, the Nov 20 Home Depot recordings, the
// validation pages; a page or search with no recording answers "not recorded"). Nothing here reaches
// Home Depot, Amazon or SerpApi.
//
//   --model <id>      claude-haiku-5-5 | claude-opus-5-5 (checked before anything else happens)
//   --dry-run         no network, no key read: the questions, their truth, what is recorded, an estimate.
//   --run             reads ANTHROPIC_API_KEY (never printed), researches every question one after another
//                     with recorded tools, no retries (a failed run is not suggested), writes
//                     fixtures/research/runs-<model>.json and scores it. Costs money (tokens and web
//                     searches): needs --max-cost, and the main session runs it after the owner's yes.
//   --replay          no network: plays the recorded model turns again through today's loop and checks
//                     them with today's code, and scores them.
//   --max-cost <usd>  with --run (required) or --dry-run: stops before the next question once the cost
//                     of the questions asked reaches it, writes what it has marked incomplete.
//
// The runs file holds each request's response as the API gave it (content blocks, usage; web search
// results with their encrypted content, which is the API's and carries no key) and the tool calls.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { gatherEvidence } from '../core/src/assist/evidence';
import type { AssistEvidence } from '../core/src/assist/types';
import { CLAUDE_JUDGE_MODELS, PRICE_TABLE, type PriceRates } from '../core/src/judge';
import {
  ClaudeResearch, estimatedResearchCost, RESEARCH_PROMPT_VERSION, researchCost, researchOutcome, researchQuestion, saidOf, scoreResearch,
  type CatalogEntry, type ResearchEvalRow, type ResearchEvalScore, type ResearchModel, type ResearchSuggestion, type ResearchTruth, type ResearchTurn,
} from '../core/src/research';
import { NONE, RESOLVED_BY_SCAN } from '../core/src/scan/answers';
import type { ReviewItem } from '../core/src/scan/types';
import { agentDataDir } from '../agent/paths';
import type { ChromeReader } from './research-chrome';
import { chromeFor, runFollowUpEval } from './research-followup-eval';
import { loadRecordedSources, recordedTools, replayedTools, type ToolCallLog } from './research-tools';
import { CacheOnlyClient, loadInputs, ResponsesCache, runValidationPipeline, VALIDATION_DATE, validationFiles } from './validate-cli';

export const DEFAULT_PAUSE_MS = 500;

export interface ResearchEvalQuestion {
  item: ReviewItem;
  evidence: AssistEvidence;
  truth: ResearchTruth;
}

export interface StoredRun {
  questionId: string;
  called: boolean;
  /** Every response of the run, in order. */
  turns: ResearchTurn[];
  tools: ToolCallLog[];
  status: ResearchSuggestion['status'];
}

export interface ResearchRunsFile {
  model: string;
  promptVersion: string;
  ranAt: string;
  results: StoredRun[];
  incomplete?: boolean;
  maxCost?: number;
}

export interface ResearchEvalDeps {
  log: (line: string) => void;
  /** The fixtures directory. */
  dir: string;
  /** Where the runs file is written and read; default <dir>/research. */
  outDir?: string;
  env: (name: string) => string | undefined;
  makeModel?: (model: string, apiKey: string) => ResearchModel;
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: number;
  now?: () => Date;
  /** --follow-up --fresh-tools --run: the owner's Chrome (default: through the running app, scripts/research-chrome.ts). */
  chrome?: ChromeReader;
}

export const runsPath = (outDir: string, model: string): string => join(outDir, `runs-${model}.json`);

const usd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/** The split questions the replay answered from the key, reopened, with the key's parts as truth; and the catalog. */
export async function loadResearchQuestions(dir: string): Promise<{ questions: ResearchEvalQuestion[]; catalog: CatalogEntry[] }> {
  const vdir = join(dir, 'validation');
  const files = validationFiles(vdir);
  const cache = new ResponsesCache(files.responses);
  const run = await runValidationPipeline({
    inputs: loadInputs(vdir), scanClient: new CacheOnlyClient(cache), lookupClient: new CacheOnlyClient(cache), continuePastMisses: true,
  });
  const questions: ResearchEvalQuestion[] = [];
  for (const stored of (await run.store.listReview()).sort((a, b) => a.id.localeCompare(b.id))) {
    if (stored.kind !== 'split' || stored.answer === null || stored.answer === RESOLVED_BY_SCAN) continue;
    const truth: ResearchTruth | null = stored.answer === NONE ? { kind: 'none' } : stored.answerParts ? { kind: 'parts', parts: stored.answerParts } : null;
    if (truth === null) continue;
    const item: ReviewItem = { ...stored, answer: null, answerParts: null, answeredAt: null };
    questions.push({ item, evidence: await gatherEvidence(run.store, item), truth });
  }
  const catalog = (await run.store.listCatalog()).map((c): CatalogEntry => ({ brand: c.brand, model: c.model, title: c.title, kind: c.isKit ? 'kit' : 'part' }));
  return { questions, catalog };
}

const truthText = (t: ResearchTruth): string => (t.kind === 'none' ? 'none' : t.parts.join(' + '));

/** One tool call as the score lists it, with where its answer came from ("recorded index" for a search the index answered). */
export function toolText(t: ToolCallLog): string {
  const input = t.input as { itemId?: string; url?: string; query?: string; model?: string };
  const what = t.tool === 'readHomeDepotPage' ? `read ${input.itemId ?? input.url ?? '?'}`
    : t.tool === 'searchHomeDepot' ? `search "${input.query ?? ''}"` : `catalog ${input.model ?? `"${input.query ?? ''}"`}`;
  const result = t.result as { results?: unknown[]; entries?: unknown[] } | undefined;
  const rows = result?.results ? `, ${result.results.length} rows` : result?.entries ? `, ${result.entries.length} entries` : '';
  return `${what} (${t.source ?? (t.recorded ? 'recorded' : 'not recorded')}${rows})`;
}

function printScore(log: (l: string) => void, s: ResearchEvalScore, rows: ResearchEvalRow[], tools: Map<string, ToolCallLog[]> = new Map()): void {
  log(`Questions scored: ${s.questions}. Questions researched: ${s.calls}.`);
  log(`Verified and correct: ${s.byOutcome.verified_correct}`);
  log(`Verified but wrong: ${s.byOutcome.verified_wrong} (must be 0 to trust)`);
  for (const w of s.wrong) log(`  ${w.questionId}: key ${truthText(rows.find((r) => r.questionId === w.questionId)!.truth)}; research ${w.said}`);
  log(`Unverified: ${s.byOutcome.unverified}`);
  log(`Cannot tell: ${s.byOutcome.cannot_tell}`);
  log(`None fits, the AI's view (never verified): ${s.byOutcome.none_suggested}`);
  log(`Not suggested: ${s.byOutcome.not_suggested}`);
  log(`Tokens: ${s.tokens.input} in, ${s.tokens.cacheWrite} written to and ${s.tokens.cacheRead} read from the cache, ${s.tokens.output} out. Web searches: ${s.webSearches}. Web fetches: ${s.webFetches}. Cost: ${usd(s.cost ?? 0)}.`);
  log('Per question:');
  for (const r of rows) {
    const sg = r.suggestion;
    const extra = sg.status === 'unverified' ? `: ${sg.reasons.join(' ')}` : sg.status === 'not_suggested' ? `: ${sg.reason}` : sg.status === 'verified' ? `: ${saidOf(sg)}` : '';
    log(`  ${r.questionId}  key ${truthText(r.truth)}  ${researchOutcome(sg, r.truth, r.item)}${extra}`);
    const calls = tools.get(r.questionId) ?? [];
    if (calls.length > 0) log(`    tools: ${calls.map(toolText).join('; ')}`);
  }
  log(s.trustworthy ? 'Overall: no verified suggestion disagrees with the key.' : 'Overall: FAIL, a verified suggestion disagrees with the key.');
}

function takeValue(args: string[], name: string): string | null | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined || v.startsWith('--') ? 1 : 2);
  return v === undefined || v.startsWith('--') ? null : v;
}

const USAGE = 'Usage: npm run research:eval -- --model <claude-haiku-5-5|claude-opus-5-5> [--follow-up] --dry-run | --run --max-cost <usd> | --replay [--fresh-tools] [--with-part-prices]';

/** A model that answers from a run's stored turns, in order, so a replay goes through the same loop. */
function replayModel(model: string, turns: ResearchTurn[]): ResearchModel {
  let i = 0;
  return {
    provider: 'replay', model,
    send: async () => {
      const t = turns[i++];
      if (!t) return { ok: false, notJudged: { reason: 'no_answer', message: 'The recorded run has no more responses.' } };
      return t;
    },
  };
}

export async function runResearchEval(args: string[], deps: ResearchEvalDeps): Promise<number> {
  const { log } = deps;
  const modes = new Set(['--dry-run', '--run', '--replay']);
  const rest = [...args];
  const model = takeValue(rest, '--model');
  const maxCostArg = takeValue(rest, '--max-cost');
  // Fix round 3: the validation part price lookups stay out of the search index unless asked for (they favour the true parts).
  const withPrices = rest.includes('--with-part-prices');
  if (withPrices) rest.splice(rest.indexOf('--with-part-prices'), 1);
  // --replay --fresh-tools: the recorded turns, but the tools answer as today's recorded tools do (what the model quoted may be gone).
  const freshTools = rest.includes('--fresh-tools');
  if (freshTools) rest.splice(rest.indexOf('--fresh-tools'), 1);
  // Step 16: --follow-up measures the follow-up loop on the recorded first asks (scripts/research-followup-eval.ts).
  const followUp = rest.includes('--follow-up');
  if (followUp) rest.splice(rest.indexOf('--follow-up'), 1);
  const known = (CLAUDE_JUDGE_MODELS as readonly string[]).includes(model ?? '');
  const maxCost = maxCostArg == null ? undefined : /^\d+(\.\d+)?$/.test(maxCostArg) && Number(maxCostArg) > 0 ? Number(maxCostArg) : NaN;
  const badValue = maxCostArg === null || Number.isNaN(maxCost);
  const mode = rest[0];
  const needsCap = mode === '--run' && maxCost === undefined;
  if (!model || !known || rest.length !== 1 || !modes.has(mode!) || badValue || needsCap) {
    log(USAGE);
    if (model && !known) log(`Unknown model "${model}". Known: ${CLAUDE_JUDGE_MODELS.join(', ')}.`);
    if (badValue) log('--max-cost takes a dollar amount above 0.');
    if (needsCap) log('--run needs --max-cost: research costs tokens and web searches.');
    return 2;
  }
  const rates: PriceRates = PRICE_TABLE[model]!;
  const outDir = deps.outDir ?? join(deps.dir, 'research');
  const file = runsPath(outDir, model);
  const shown = `fixtures/research/runs-${model}.json`;

  let loaded;
  try { loaded = await loadResearchQuestions(deps.dir); } catch (e) { log(e instanceof Error ? e.message : 'Could not read the inputs.'); return 1; }
  const { questions, catalog } = loaded;
  const sources = loadRecordedSources(deps.dir, { partPrices: withPrices });
  if (followUp) {
    return runFollowUpEval({
      mode: mode as '--dry-run' | '--run' | '--replay', model, rates, maxCost, fresh: freshTools, questions, catalog, deps, outDir,
      ...(freshTools && mode === '--run' ? { chrome: deps.chrome ?? chromeFor(agentDataDir()) } : {}),
    });
  }

  if (mode === '--dry-run') {
    const each = estimatedResearchCost(model) ?? 0;
    log(`Research eval, dry run (no network, no key read). Model ${model}, prompt ${RESEARCH_PROMPT_VERSION}, validation set ${VALIDATION_DATE}.`);
    log(`Questions: ${questions.length} split questions, reopened from the answer key. Tools: recorded files only (${sources.pages.size} pages, ${sources.searches.size} searches); anything else answers "not recorded". Searches not recorded word for word answer from an index of ${sources.products.length} recorded products${withPrices ? ', the validation part price lookups included' : ' (the validation part price lookups left out; --with-part-prices adds them)'}.`);
    for (const q of questions) {
      const id = /^homedepot:(\d+)$/.exec(q.item.subject)?.[1] ?? '';
      log(`  ${q.item.id}  key ${truthText(q.truth)}${sources.pages.has(id) ? '' : '  (its page is not recorded)'}`);
    }
    log(`Estimated cost: ${usd(each * questions.length)} (${usd(each)} a question: an estimate of tokens and one web search, not a bill).`);
    if (maxCost !== undefined) log(`A run would stop before the next question once the cost reached ${usd(maxCost)}.`);
    log(`A run would write ${shown}.`);
    return 0;
  }

  const rows: ResearchEvalRow[] = [];
  const add = (q: ResearchEvalQuestion, suggestion: ResearchSuggestion, called: boolean) =>
    rows.push({ questionId: q.item.id, item: q.item, truth: q.truth, suggestion, called });
  let cut: { maxCost: number; done: number; of: number } | null = null;
  const toolLogs = new Map<string, ToolCallLog[]>();

  if (mode === '--replay') {
    if (!existsSync(file)) { log(`No runs file for ${model}. Nothing to replay.`); return 1; }
    const doc = JSON.parse(readFileSync(file, 'utf8')) as ResearchRunsFile;
    log(`Research eval, replay of ${shown} (no network).`);
    if (doc.promptVersion !== RESEARCH_PROMPT_VERSION) log(`The runs were made with prompt ${doc.promptVersion}; today's prompt is ${RESEARCH_PROMPT_VERSION}. They are checked with today's code.`);
    const runs = new Map(doc.results.map((r) => [r.questionId, r] as const));
    let older = 0;
    for (const q of questions) {
      const stored = runs.get(q.item.id);
      if (!stored) continue;
      // The tools give back what they gave the model; a run recorded before results were kept asks today's recorded tools.
      const kept = !freshTools && stored.tools.every((t) => t.result !== undefined);
      if (!kept && !freshTools) older++;
      const calls: ToolCallLog[] = [];
      const tools = kept ? replayedTools(stored.tools) : recordedTools(sources, catalog, calls);
      const s = await researchQuestion(q.item, q.evidence, tools, replayModel(model, stored.turns), { catalog });
      toolLogs.set(q.item.id, kept ? stored.tools : calls);
      add(q, s, stored.called);
    }
    if (older > 0) log(`${older} question${older === 1 ? '' : 's'} of this file kept no tool results: their tools answer as today's recorded tools do, which the model may not have seen.`);
    if (freshTools) log(`--fresh-tools: the tools answer as today's recorded tools do${withPrices ? ', part price lookups included' : ''}, not as they answered the model; what it quoted may be gone.`);
    if (doc.incomplete) cut = { maxCost: doc.maxCost ?? 0, done: doc.results.length, of: questions.length };
  } else {
    const apiKey = deps.env('ANTHROPIC_API_KEY');
    if (!apiKey) { log('ANTHROPIC_API_KEY must be set (in .env or the environment). Nothing was called.'); return 1; }
    const real = deps.makeModel ? deps.makeModel(model, apiKey) : new ClaudeResearch({ apiKey, model });
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pause = deps.pauseMs ?? DEFAULT_PAUSE_MS;
    const results: StoredRun[] = [];
    let spent = 0;
    log(`Research eval, run. Model ${model}, ${questions.length} questions, one after another, recorded tools only. Stops at ${usd(maxCost!)}.`);
    for (const q of questions) {
      if (spent >= maxCost!) {
        cut = { maxCost: maxCost!, done: results.length, of: questions.length };
        break;
      }
      const turns: ResearchTurn[] = [];
      const calls: ToolCallLog[] = [];
      const recording: ResearchModel = {
        provider: real.provider, model: real.model,
        send: async (req, signal) => {
          const t = await real.send(req, signal);
          turns.push(t);
          return t;
        },
      };
      const s = await researchQuestion(q.item, q.evidence, recordedTools(sources, catalog, calls), recording, { catalog });
      results.push({ questionId: q.item.id, called: turns.length > 0, turns, tools: calls, status: s.status });
      toolLogs.set(q.item.id, calls);
      add(q, s, turns.length > 0);
      if (turns.some((t) => !t.ok && t.notJudged.reason === 'auth')) { log('The key was refused. Stopped; nothing written.'); return 1; }
      if (s.usage) spent += researchCost(s.usage, rates);
      if (turns.length > 0) await sleep(pause);
    }
    const doc: ResearchRunsFile = {
      model, promptVersion: RESEARCH_PROMPT_VERSION, ranAt: (deps.now?.() ?? new Date()).toISOString(), results,
      ...(cut ? { incomplete: true, maxCost: cut.maxCost } : {}),
    };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
    log(`Wrote ${shown}.`);
  }

  if (cut) log(`Run cut by --max-cost ${usd(cut.maxCost)} after ${cut.done} of ${cut.of} questions: the score covers only those ${cut.done}.`);
  printScore(log, scoreResearch(rows, rates), rows, toolLogs);
  return 0;
}
