// `npm run research:eval -- --model <id> --follow-up ...`: the follow-up loop (core/src/research/followUp.ts) measured on the
// 19-question answer key. Each question's first ask is the recorded run (fixtures/research/runs-<model>.json) replayed free
// through today's loop and checked by today's code: "before". Then, for every first answer that is unverified or cannot
// tell, the loop: its tasks read Home Depot from the recordings (scripts/research-tools.ts), the code checks again, and the
// follow-up asks are made (--run, paid), or played back (--replay, free). "After" is each question's final suggestion.
//
//   --dry-run        no network, no key: per question the tasks and what they read (free, from the recordings), whether the
//                    code's check alone verifies it, which would be asked again, and the estimated cost.
//   --run            reads ANTHROPIC_API_KEY (never printed); needs --max-cost; writes fixtures/research/followup-<model>.json.
//   --replay         no network: plays the recorded follow-up turns again and scores them.
//   --fresh-tools    with --run: a page or search a follow-up needs that no recording holds is read in the owner's Chrome
//                    through the running app (scripts/research-chrome.ts) and recorded on first use; with --dry-run it lists
//                    them instead. Without it they answer "not recorded".
// The bar: zero verified-wrong after the loop.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Suggestion } from '../core/src/assist/types';
import type { PriceRates } from '../core/src/judge';
import {
  ClaudeResearch, estimatedResearchCost, researchCost, researchOutcome, researchQuestion, saidOf, scoreResearch,
  type ResearchEvalRow, type ResearchModel, type ResearchSuggestion, type ResearchTurn,
} from '../core/src/research';
import { FOLLOW_UP_VERSION_SUFFIX, RESEARCH_PROMPT_VERSION } from '../core/src/research/prompt';
import { runFollowUp, type FollowUpAsk, type FollowUpResult } from '../core/src/research/followUp';
import { agentChrome, FRESH_FILE, freshTools, plannedTools, type ChromeReader } from './research-chrome';
import { loadRecordedSources, recordedTools, replayedTools, type ToolCallLog } from './research-tools';
import type { ResearchEvalDeps, ResearchEvalQuestion, ResearchRunsFile } from './research-eval-cli';

export interface FollowUpRun {
  questionId: string;
  /** Each follow-up ask: its responses in order and its own tool calls. */
  asks: { turns: ResearchTurn[]; tools: ToolCallLog[] }[];
  /** The loop's own reads (tasks), as they were answered. */
  reads: ToolCallLog[];
  final: Suggestion['status'];
}

export interface FollowUpRunsFile {
  model: string;
  promptVersion: string;
  ranAt: string;
  results: FollowUpRun[];
  incomplete?: boolean;
  maxCost?: number;
}

export const followUpPath = (outDir: string, model: string): string => join(outDir, `followup-${model}.json`);

const usd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;

function replayModel(model: string, turns: ResearchTurn[]): ResearchModel {
  let i = 0;
  return { provider: 'replay', model, send: async () => turns[i++] ?? { ok: false, notJudged: { reason: 'no_answer', message: 'The recorded run has no more responses.' } } };
}

/** The final suggestion of a question after the loop: the code's check again, else the last follow-up ask, else the first. */
function finalOf(first: ResearchSuggestion, r: FollowUpResult | null): Suggestion {
  if (!r) return first;
  if (r.rechecked) return { ...first, ...r.rechecked } as Suggestion;
  return r.asks.at(-1)?.suggestion ?? first;
}

export async function runFollowUpEval(input: {
  mode: '--dry-run' | '--run' | '--replay'; model: string; rates: PriceRates; maxCost: number | undefined; fresh: boolean;
  questions: ResearchEvalQuestion[]; catalog: Parameters<typeof recordedTools>[1]; deps: ResearchEvalDeps; outDir: string;
  chrome?: ChromeReader;
}): Promise<number> {
  const { mode, model, rates, questions, catalog, deps } = input;
  const { log } = deps;
  const firstFile = join(input.outDir, `runs-${model}.json`);
  const file = followUpPath(input.outDir, model);
  const shown = `fixtures/research/followup-${model}.json`;
  if (!existsSync(firstFile)) { log(`No recorded first asks for ${model} (fixtures/research/runs-${model}.json): run research:eval --run first.`); return 1; }
  const firsts = new Map((JSON.parse(readFileSync(firstFile, 'utf8')) as ResearchRunsFile).results.map((r) => [r.questionId, r] as const));
  const sources = loadRecordedSources(deps.dir, { followUp: true });
  const each = estimatedResearchCost(model);

  log(`Follow-up eval, ${mode.slice(2)}. Model ${model}, prompt ${RESEARCH_PROMPT_VERSION}${FOLLOW_UP_VERSION_SUFFIX} for follow-up asks. First asks: fixtures/research/runs-${model}.json, replayed free.`);
  const recorded: FollowUpRunsFile | null = mode === '--replay' ? (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as FollowUpRunsFile : null) : null;
  if (mode === '--replay' && !recorded) { log(`No ${shown} to replay.`); return 1; }
  const real = mode === '--run' ? (() => {
    const apiKey = deps.env('ANTHROPIC_API_KEY');
    if (!apiKey) return null;
    return deps.makeModel ? deps.makeModel(model, apiKey) : new ClaudeResearch({ apiKey, model });
  })() : undefined;
  if (real === null) { log('ANTHROPIC_API_KEY must be set (in .env or the environment). Nothing was called.'); return 1; }

  const before: ResearchEvalRow[] = [];
  const after: ResearchEvalRow[] = [];
  const results: FollowUpRun[] = [];
  const planned: string[] = [];
  const fresh = { reads: 0 };
  let spent = 0;
  let wouldAsk = 0;
  /** --dry-run --fresh-tools: questions whose reads are not recorded; each is asked again if Chrome finds something. */
  let mayAsk = 0;
  let cut = false;
  const lines: string[] = [];
  for (const q of questions) {
    const stored = firsts.get(q.item.id);
    if (!stored) continue;
    const first = await researchQuestion(q.item, q.evidence, replayedTools(stored.tools), replayModel(model, stored.turns), { catalog });
    before.push({ questionId: q.item.id, item: q.item, truth: q.truth, suggestion: first, called: stored.called });
    if (first.status !== 'unverified' && first.status !== 'cannot_tell') {
      after.push({ questionId: q.item.id, item: q.item, truth: q.truth, suggestion: first, called: false });
      continue;
    }
    if (mode === '--run' && spent >= input.maxCost!) {
      cut = true;
      after.push({ questionId: q.item.id, item: q.item, truth: q.truth, suggestion: first, called: false });
      continue;
    }
    if (mode === '--replay' && !recorded!.results.some((r) => r.questionId === q.item.id)) {
      after.push({ questionId: q.item.id, item: q.item, truth: q.truth, suggestion: first, called: false });
      continue;
    }
    const plannedBefore = planned.length;
    const reads: ToolCallLog[] = [];
    const base = recordedTools(sources, catalog, reads);
    const replays = recorded?.results.find((r) => r.questionId === q.item.id);
    // A replay gives the loop's reads back as the run got them (Chrome's answers included), in order.
    const tools = mode === '--replay' ? replayedTools(replays?.reads ?? [])
      : mode === '--dry-run' && input.fresh ? plannedTools(base, sources, planned)
        : mode === '--run' && input.fresh && input.chrome ? freshTools(base, sources, input.chrome, join(input.outDir, 'tools', FRESH_FILE), reads, fresh) : base;
    const run: FollowUpRun = { questionId: q.item.id, asks: [], reads, final: first.status };
    let n = 0;
    const ask: FollowUpAsk | null = mode === '--dry-run' ? null : async (followUp, signal) => {
      const i = n++;
      const turns: ResearchTurn[] = [];
      const calls: ToolCallLog[] = [];
      let m: ResearchModel;
      let askTools = tools;
      if (mode === '--replay') {
        const a = replays?.asks[i];
        m = replayModel(model, a?.turns ?? []);
        askTools = replayedTools(a?.tools ?? []);
      } else {
        m = { provider: real!.provider, model: real!.model, send: async (req, sig) => { const t = await real!.send(req, sig); turns.push(t); return t; } };
        askTools = recordedTools(sources, catalog, calls);
        if (input.fresh && input.chrome) askTools = freshTools(askTools, sources, input.chrome, join(input.outDir, 'tools', FRESH_FILE), calls, fresh);
      }
      const suggestion = await researchQuestion(q.item, q.evidence, askTools, m, { ...(signal ? { signal } : {}), catalog, followUp });
      run.asks.push({ turns, tools: calls });
      return { suggestion, costUsd: suggestion.usage ? researchCost(suggestion.usage, rates) : 0 };
    };
    const r = await runFollowUp({
      item: q.item, catalog, start: { checked: first, answer: first.research.answer, trace: first.research },
      tools: () => tools, ask, estimateUsd: mode === '--replay' ? 0 : each, spentUsd: 0, capUsd: mode === '--run' ? Math.max(0, input.maxCost! - spent) : Number.POSITIVE_INFINITY, now: () => Date.now(),
    });
    spent += r.costUsd;
    if (mode === '--dry-run' && r.state.reason === 'The app read the pages; asking the AI again with them is off.') wouldAsk += 1;
    else if (mode === '--dry-run' && !r.rechecked && planned.length > plannedBefore) mayAsk += 1;
    const final = finalOf(first, r);
    run.final = final.status;
    results.push(run);
    after.push({ questionId: q.item.id, item: q.item, truth: q.truth, suggestion: final, called: r.asks.length > 0 });
    lines.push(`  ${q.item.id}  first ${researchOutcome(first, q.truth, q.item)} → ${researchOutcome(final, q.truth, q.item)}${final.status === 'verified' ? ` (${saidOf(final)})` : ''}${r.rechecked ? ', by the code\'s check alone' : r.asks.length > 0 ? `, ${r.asks.length} follow-up ask${r.asks.length === 1 ? '' : 's'} (${usd(r.costUsd)})` : ''}`);
    for (const t of r.state.tried) lines.push(`    ${t.what} — ${t.result}${t.url ? ` ${t.url}` : ''}`);
    if (r.state.reason) lines.push(`    stopped: ${r.state.reason}`);
  }

  const b = scoreResearch(before, rates);
  const a = scoreResearch(after, rates);
  log(`Before the loop: verified right ${b.byOutcome.verified_correct}, verified wrong ${b.byOutcome.verified_wrong}, unverified ${b.byOutcome.unverified}, cannot tell ${b.byOutcome.cannot_tell} (of ${b.questions}).`);
  log(`After the loop:  verified right ${a.byOutcome.verified_correct}, verified wrong ${a.byOutcome.verified_wrong}, unverified ${a.byOutcome.unverified}, cannot tell ${a.byOutcome.cannot_tell} (of ${a.questions}).`);
  for (const w of a.wrong) log(`  WRONG ${w.questionId}: ${w.said}`);
  log('Per question the loop ran for:');
  for (const l of lines) log(l);
  if (mode === '--dry-run') {
    const n = wouldAsk + mayAsk;
    log(`Would ask again: ${wouldAsk} question${wouldAsk === 1 ? '' : 's'} whose recorded reads found something new${input.fresh ? `, and up to ${mayAsk} more whose reads are made in Chrome` : ''}. Estimated cost: ${usd((each ?? 0) * n)} for one follow-up ask each, at most ${usd((each ?? 0) * n * 2)} with a second round (${usd(each ?? 0)} an ask: an estimate, not a bill).`);
    if (input.fresh) log(`--fresh-tools: ${planned.length} read${planned.length === 1 ? '' : 's'} not recorded would be made in the owner's Chrome, free: ${planned.join('; ') || 'none'}.`);
    else log('Reads not recorded answered "not recorded"; --fresh-tools lists those a run would make in Chrome.');
    log(`A run would write ${shown}.`);
    return 0;
  }
  log(`Follow-up cost: ${usd(spent)}.${input.fresh ? ` Reads made in Chrome: ${fresh.reads} (recorded in fixtures/research/tools/${FRESH_FILE}).` : ''}`);
  if (cut) log(`Cut by --max-cost ${usd(input.maxCost!)}: the questions after it kept their first answer.`);
  if (mode === '--run') {
    const doc: FollowUpRunsFile = { model, promptVersion: RESEARCH_PROMPT_VERSION + FOLLOW_UP_VERSION_SUFFIX, ranAt: (deps.now?.() ?? new Date()).toISOString(), results, ...(cut ? { incomplete: true, maxCost: input.maxCost! } : {}) };
    mkdirSync(input.outDir, { recursive: true });
    writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
    log(`Wrote ${shown}.`);
  }
  log(a.trustworthy ? 'Overall: no verified suggestion disagrees with the key.' : 'Overall: FAIL, a verified suggestion disagrees with the key.');
  return 0;
}

/** The owner's Chrome through the running app, for --run --fresh-tools. */
export const chromeFor = (dataDir: string): ChromeReader => agentChrome({ dataDir });
