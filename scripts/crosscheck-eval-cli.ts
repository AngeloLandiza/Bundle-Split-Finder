// npm run crosscheck:eval: step 16, lever 4, a harness only (OFF: nothing in the agent or Autopilot calls it). For every
// recorded research answer the code did NOT verify (fixtures/research/runs-*.json, the 19 split questions with the key),
// a second, different model is given only the code-verified quotes of that answer (each found word for word in the source
// it names, flattened and sorted so the first answer's grouping by part is gone) and the bundle's own Includes lines,
// never the first answer's parts or reason, and must give the parts itself. "Agree" = the same models with the same
// quantities (kitKey: PCL500 and PCL500B are one tool). Scored against the key: how many unverified-but-right answers
// agreement would release, and how many wrong ones it would let through. The only use proposed, if measured at zero
// wrong: "two models agree, check and approve", still the owner's approval, never Autopilot.
//
//   --dry-run          no network, no key: the questions, each prompt (--show N prints N in full) and the estimated cost.
//   --run --max-cost   reads ANTHROPIC_API_KEY (never printed), asks the second model once a prompt, no retries, writes
//                      fixtures/research/crosscheck-<model>.json and scores it. Costs money: the main session runs it.
//   --replay           no network: scores the written file.
//   --model <id>       default claude-sonnet-5-5.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { answerFrom } from '../core/src/ai/answer';
import { ClaudeProvider } from '../core/src/ai/claude';
import type { ModelProvider } from '../core/src/ai/types';
import { normaliseText } from '../core/src/judge/verify';
import type { PriceRates } from '../core/src/judge/eval';
import { kitKey } from '../core/src/match';
import { researchQuestion } from '../core/src/research/loop';
import type { ResearchAnswer, ResearchLedgerEntry, ResearchModel, ResearchTurn } from '../core/src/research/types';
import { includesItems } from '../core/src/research/verify';
import type { ReviewItem } from '../core/src/scan/types';
import { loadResearchQuestions, type ResearchRunsFile } from './research-eval-cli';
import { loadRecordedSources, recordedTools, replayedTools } from './research-tools';

export const CROSSCHECK_PROMPT_VERSION = 'crosscheck-2026-11-23.1';
export const DEFAULT_CROSSCHECK_MODEL = 'claude-sonnet-5-5';
/** Anthropic's published rates (claude-api reference, cached 2026-11-03): Sonnet 5.5 $2 in, $10 out, $0.10 cache read a million. */
export const CROSSCHECK_RATES: Record<string, PriceRates> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
/** An estimate's output a prompt: a short JSON answer and the model's thinking. */
export const ESTIMATED_OUTPUT_TOKENS = 600;
export const RUN_FILES = ['runs-claude-opus-5-5-prompt1.json', 'runs-claude-opus-5-5-prompt2.json', 'runs-claude-opus-5-5-prompt3.json', 'runs-claude-opus-5-5.json'];

export const CROSSCHECK_SYSTEM = [
  'You check what a Home Depot bundle contains. You are given the bundle\'s own words and some lines that were checked word for word against Home Depot pages, Home Depot search rows and a catalog.',
  'Give the bundle\'s parts: every product in it that is sold by itself under its own model number, each once with its quantity. A kit the catalog marks "(kit)" is one part.',
  'Use only model numbers written in the lines given. Do not use anything you know from elsewhere. Every item the bundle lists must belong to one of your parts.',
  'If the lines do not settle which model numbers the parts are, answer cannot_tell with no parts.',
].join('\n');

export const CROSSCHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['decision', 'parts'],
  properties: {
    decision: { type: 'string', enum: ['parts', 'cannot_tell'] },
    parts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['model', 'qty'], properties: { model: { type: 'string' }, qty: { type: 'integer' } } } },
  },
} as const;

export interface CrosscheckCase {
  /** The run file and question: `<file>#<questionId>`. */
  id: string;
  item: ReviewItem;
  /** The first answer's parts, each model repeated by its quantity, upper case. */
  first: string[];
  /** The first answer is the key's. */
  firstRight: boolean;
  /** Its prompt; equal prompts are asked once. */
  user: string;
}

const up = (s: string): string => s.trim().toUpperCase();
const bag = (brand: string, parts: readonly string[]): string => parts.map((p) => kitKey(brand, p)).sort().join(',');
const partsOf = (a: ResearchAnswer): string[] => a.parts.flatMap((p) => Array<string>(Math.max(0, Math.min(9, p.qty))).fill(up(p.model)));

/** The quotes of an answer the code found word for word in the source each names, each once, sorted: no part's grouping. */
export function verifiedQuotes(a: ResearchAnswer, ledger: readonly ResearchLedgerEntry[]): { source: string; text: string }[] {
  const out = new Map<string, { source: string; text: string }>();
  for (const q of [...a.quotes, ...a.parts.flatMap((p) => p.quotes)]) {
    const e = ledger.find((x) => x.id === q.sourceId.trim());
    const norm = normaliseText(q.quote);
    if (!e || norm === '' || !e.lines.some((l) => !l.suspect && normaliseText(l.text).includes(norm))) continue;
    const key = `${e.label}|${norm}`;
    if (!out.has(key)) out.set(key, { source: e.label, text: q.quote.trim().replace(/\s+/g, ' ') });
  }
  return [...out.values()].sort((x, y) => x.source.localeCompare(y.source) || x.text.localeCompare(y.text));
}

/** The prompt: the bundle's title and model number, its own Includes lines, and the verified quotes. Never the first answer. */
export function crosscheckPrompt(item: ReviewItem, ledger: readonly ResearchLedgerEntry[], quotes: readonly { source: string; text: string }[]): string {
  const bundle = ledger.filter((e) => e.isBundle);
  const includes = [...new Set(bundle.flatMap((e) => e.lines.filter((l) => !l.suspect && /^\s*includes\b/i.test(l.text)).map((l) => l.text)))];
  const listed = includesItems(item.brand, [...bundle]).length;
  return [
    `Bundle: ${item.brand} ${item.model}`,
    `Title: ${item.title ?? ''}`,
    includes.length > 0 ? `The bundle's Includes lines (${listed} items):\n${includes.map((t) => `- ${t}`).join('\n')}` : 'The bundle\'s page has no Includes lines.',
    `Checked lines:\n${quotes.map((q) => `- [${q.source}] ${q.text}`).join('\n') || '- (none)'}`,
  ].join('\n\n');
}

/** Every unverified parts answer of the run files, replayed through today's loop and verifier, with its prompt. */
export async function crosscheckCases(fixtures: string, files: readonly string[] = RUN_FILES): Promise<CrosscheckCase[]> {
  const { questions, catalog } = await loadResearchQuestions(fixtures);
  const sources = loadRecordedSources(fixtures);
  const out: CrosscheckCase[] = [];
  for (const file of files) {
    const doc = JSON.parse(readFileSync(join(fixtures, 'research', file), 'utf8')) as ResearchRunsFile;
    for (const q of questions) {
      const stored = doc.results.find((r) => r.questionId === q.item.id);
      if (!stored) continue;
      let i = 0;
      const model: ResearchModel = { provider: 'replay', model: doc.model, send: async () => (stored.turns[i++] as ResearchTurn | undefined) ?? { ok: false, notJudged: { reason: 'no_answer', message: 'no more turns' } } };
      const kept = stored.tools.every((x) => x.result !== undefined);
      const s = await researchQuestion(q.item, q.evidence, kept ? replayedTools(stored.tools) : recordedTools(sources, catalog, []), model, { catalog });
      const a = s.research.answer;
      if (s.status !== 'unverified' || !a || a.decision !== 'parts' || a.parts.length === 0) continue;
      const first = partsOf(a);
      out.push({
        id: `${file}#${q.item.id}`, item: q.item, first,
        firstRight: q.truth.kind === 'parts' && bag(q.item.brand, first) === bag(q.item.brand, q.truth.parts),
        user: crosscheckPrompt(q.item, s.research.ledger, verifiedQuotes(a, s.research.ledger)),
      });
    }
  }
  return out;
}

/** Tokens a text is, roughly (4 characters a token), for an estimate only. */
export const roughTokens = (text: string): number => Math.ceil(text.length / 4);

export function estimatedCost(prompts: readonly string[], rates: PriceRates): number {
  const input = prompts.reduce((n, p) => n + roughTokens(CROSSCHECK_SYSTEM) + roughTokens(p) + 200, 0);
  return (input * rates.input + prompts.length * ESTIMATED_OUTPUT_TOKENS * rates.output) / 1_000_000;
}

export interface CrosscheckAnswer { decision: 'parts' | 'cannot_tell'; parts: { model: string; qty: number }[] }

/** The second model's answer as its schema shapes it, or null for anything else (never guessed into shape). */
export function parseCrosscheck(text: string): CrosscheckAnswer | null {
  try {
    const v = JSON.parse(text) as Partial<CrosscheckAnswer>;
    if ((v.decision !== 'parts' && v.decision !== 'cannot_tell') || !Array.isArray(v.parts)) return null;
    if (!v.parts.every((p) => typeof p?.model === 'string' && Number.isInteger(p.qty) && p.qty >= 1 && p.qty <= 9)) return null;
    return { decision: v.decision, parts: v.parts };
  } catch {
    return null;
  }
}

export interface CrosscheckScore { cases: number; agreeRight: number; agreeWrong: number; disagreeRight: number; disagreeWrong: number; noAnswer: number }

/** Agreement against the key: agreeRight are released right answers, agreeWrong wrong ones let through (must be 0). */
export function scoreCrosscheck(cases: readonly CrosscheckCase[], answers: ReadonlyMap<string, CrosscheckAnswer | null>): CrosscheckScore {
  const s: CrosscheckScore = { cases: cases.length, agreeRight: 0, agreeWrong: 0, disagreeRight: 0, disagreeWrong: 0, noAnswer: 0 };
  for (const c of cases) {
    const a = answers.get(c.user);
    if (!a) {
      s.noAnswer++;
      continue;
    }
    const agree = a.decision === 'parts' && a.parts.length > 0 && bag(c.item.brand, a.parts.flatMap((p) => Array<string>(p.qty).fill(up(p.model)))) === bag(c.item.brand, c.first);
    if (agree) s[c.firstRight ? 'agreeRight' : 'agreeWrong']++;
    else s[c.firstRight ? 'disagreeRight' : 'disagreeWrong']++;
  }
  return s;
}

interface CrosscheckFile { model: string; promptVersion: string; ranAt: string; answers: { user: string; text: string | null; usage?: unknown }[] }

export interface CrosscheckDeps {
  log: (line: string) => void;
  dir: string;
  env: (name: string) => string | undefined;
  makeProvider?: (model: string, apiKey: string) => ModelProvider;
  now?: () => Date;
}

const value = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const usd = (n: number): string => `$${n.toFixed(4)}`;

export async function runCrosscheckEval(args: string[], deps: CrosscheckDeps): Promise<number> {
  const { log } = deps;
  const model = value(args, '--model') ?? DEFAULT_CROSSCHECK_MODEL;
  const mode = ['--dry-run', '--run', '--replay'].find((m) => args.includes(m));
  const rates = CROSSCHECK_RATES[model];
  const maxCost = value(args, '--max-cost') === undefined ? undefined : Number(value(args, '--max-cost'));
  if (!mode || !rates || (mode === '--run' && !(maxCost !== undefined && maxCost > 0))) {
    log('Usage: npm run crosscheck:eval -- [--model claude-sonnet-5-5|claude-haiku-5-5] --dry-run [--show N] | --run --max-cost <usd> | --replay');
    if (!rates) log(`No price is known for ${model}; a cost is never guessed.`);
    return 2;
  }
  const cases = await crosscheckCases(deps.dir);
  const prompts = [...new Set(cases.map((c) => c.user))];
  const file = join(deps.dir, 'research', `crosscheck-${model}.json`);
  log(`Cross-check (lever 4, harness only, off), model ${model}, prompt ${CROSSCHECK_PROMPT_VERSION}.`);
  log(`Unverified answers on the recorded runs: ${cases.length} (${cases.filter((c) => c.firstRight).length} right per the key, ${cases.filter((c) => !c.firstRight).length} not); distinct prompts: ${prompts.length}.`);

  if (mode === '--dry-run') {
    const show = Number(value(args, '--show') ?? 1);
    for (const c of cases) log(`  ${c.id}  first answer ${c.first.join(' + ')}  ${c.firstRight ? 'right' : 'WRONG'} per the key`);
    for (const p of prompts.slice(0, show)) log(`--- system ---\n${CROSSCHECK_SYSTEM}\n--- user ---\n${p}\n---`);
    log(`Estimated cost: ${usd(estimatedCost(prompts, rates))} for ${prompts.length} calls (about 4 characters a token, ${ESTIMATED_OUTPUT_TOKENS} tokens out a call; an estimate, not a bill).`);
    return 0;
  }

  const answers = new Map<string, CrosscheckAnswer | null>();
  if (mode === '--replay') {
    if (!existsSync(file)) {
      log(`No ${file}. Nothing to score.`);
      return 1;
    }
    const doc = JSON.parse(readFileSync(file, 'utf8')) as CrosscheckFile;
    for (const a of doc.answers) answers.set(a.user, a.text === null ? null : parseCrosscheck(a.text));
  } else {
    const key = deps.env('ANTHROPIC_API_KEY');
    if (!key) {
      log('ANTHROPIC_API_KEY must be set. Nothing was called.');
      return 1;
    }
    const provider = deps.makeProvider ? deps.makeProvider(model, key) : new ClaudeProvider({ apiKey: key, model });
    const kept: CrosscheckFile['answers'] = [];
    let spent = 0;
    for (const user of prompts) {
      if (spent >= maxCost!) {
        log(`Stopped at --max-cost ${usd(maxCost!)} after ${kept.length} of ${prompts.length} calls.`);
        break;
      }
      const res = await provider.send({ system: CROSSCHECK_SYSTEM, messages: [{ role: 'user', content: user }], responseSchema: CROSSCHECK_SCHEMA, maxTokens: 4000, effort: 'low' });
      const ans = answerFrom(res, provider.label);
      const usage = res.ok ? res.usage : res.usage;
      if (usage) spent += (usage.inputTokens * rates.input + usage.outputTokens * rates.output) / 1_000_000;
      if (!res.ok && res.notJudged.reason === 'auth') {
        log('The key was refused. Stopped; nothing written.');
        return 1;
      }
      kept.push({ user, text: ans.ok ? ans.answer : null, ...(usage ? { usage } : {}) });
      answers.set(user, ans.ok ? parseCrosscheck(ans.answer) : null);
    }
    writeFileSync(file, JSON.stringify({ model, promptVersion: CROSSCHECK_PROMPT_VERSION, ranAt: (deps.now?.() ?? new Date()).toISOString(), answers: kept } satisfies CrosscheckFile, null, 1) + '\n');
    log(`Wrote ${file}. Cost: ${usd(spent)}.`);
  }
  const s = scoreCrosscheck(cases, answers);
  log(`Agreement would release ${s.agreeRight} unverified answers the key says are right, and let through ${s.agreeWrong} wrong ones (must be 0).`);
  log(`Disagreed: ${s.disagreeRight} right, ${s.disagreeWrong} wrong. No answer: ${s.noAnswer}.`);
  return 0;
}
