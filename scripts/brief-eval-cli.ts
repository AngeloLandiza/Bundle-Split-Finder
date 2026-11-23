// npm run brief:eval: what the brief pipeline writes for the owner's real suggestions, and what the code's checks make of it.
//
//   --dry-run          no network, no key read: the prompts the model would get, an estimate of tokens and cost.
//   (no flag)          reads ANTHROPIC_API_KEY (never printed), makes one call per suggestion with at least one found quote, one after
//                      another with a short pause and no retries, and prints each brief with the verdict on each of its sentences
//                      and the total cost. Writes nothing. Costs money: the main session runs it after the owner's yes.
//   --data scan3|scan2 scan3 (default): the 10 open questions of the third real scan (after-scan3) with the suggestions the AI gave
//                      them on the second (5 of them have one); scan2: the 15 questions of the second scan, each with its suggestion.
//   --model <id>       the model that writes the briefs (default claude-haiku-5-5).
//   --max-cost <usd>   stops before the next call once the calls made cost this much.
//
// The suggestions are the AI's real answers, read from fixtures/e2e-2026-11-23/store/suggestions.json; the pages are the stored
// ones. A suggestion is used even when its question has changed since (its `seen` no longer matches): this measures the brief, not
// the app's liveness rule.

import { join } from 'node:path';

import { ClaudeProvider } from '../core/src/ai/claude';
import { gatherEvidence } from '../core/src/assist/evidence';
import type { StoredSuggestion } from '../core/src/assist/stored';
import { briefInputOf, linksOfEvidence, poolOfEvidence } from '../core/src/brief/input';
import { BRIEF_PROMPT_VERSION, briefRequest } from '../core/src/brief/prompt';
import { type BriefModel, ESTIMATED_BRIEF_TOKENS, ProviderBrief, worthABrief, writeBrief } from '../core/src/brief/pipeline';
import type { BriefInput, ReviewBrief } from '../core/src/brief/types';
import { costOf, PRICE_TABLE } from '../core/src/judge/eval';
import type { ReviewItem } from '../core/src/scan/types';
import { loadScanFolder, readStoreFile } from './data-folder';

export const DEFAULT_PAUSE_MS = 300;
export const CHARS_PER_TOKEN = 4;
const DEFAULT_MODEL = 'claude-haiku-5-5';

export interface BriefEvalDeps {
  log: (line: string) => void;
  /** The repo's fixtures folder. */
  dir: string;
  env: (name: string) => string | undefined;
  makeModel?: (model: string, apiKey: string) => BriefModel;
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: number;
}

interface Case {
  item: ReviewItem;
  suggestion: StoredSuggestion | null;
  input: BriefInput;
}

const usd = (n: number): string => `$${n.toFixed(n < 0.01 ? 5 : 4)}`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const show = (brief: ReviewBrief): string[] => [
  `    ask:        ${brief.ask}`,
  `    suggestion: ${brief.suggestion ?? '(none)'}`,
  `    state:      ${brief.state}   written by: ${brief.writtenBy}`,
  ...brief.reasons.flatMap((r, i) => [`    reason ${i + 1}:   ${r.text}`, ...(r.quote ? [`      quote:    "${r.quote.length > 140 ? `${r.quote.slice(0, 139)}…` : r.quote}" (${r.sourceLabel ?? 'source'})`] : [])]),
  `    check:      ${brief.check ? `${brief.check.text}${brief.check.url ? `  -> ${brief.check.linkLabel ?? 'link'}` : ''}` : '(none)'}`,
];

/** Runs the eval. Returns the process exit code. */
export async function runBriefEval(args: string[], deps: BriefEvalDeps): Promise<number> {
  const { log } = deps;
  const dryRun = args.includes('--dry-run');
  const data = flagValue(args, '--data') ?? 'scan3';
  if (data !== 'scan3' && data !== 'scan2') { log('--data is scan3 or scan2.'); return 1; }
  const model = flagValue(args, '--model') ?? DEFAULT_MODEL;
  const maxCostArg = flagValue(args, '--max-cost');
  const maxCost = maxCostArg === undefined ? undefined : Number(maxCostArg);
  if (maxCost !== undefined && !(maxCost > 0)) { log('--max-cost needs a number of dollars above 0.'); return 1; }
  const rates = PRICE_TABLE[model];
  if (!rates) { log(`No price is known for ${model}; add it to the price table before measuring it.`); return 1; }

  const root = join(deps.dir, 'e2e-2026-11-23');
  const scanDir = data === 'scan3' ? join(root, 'after-scan3') : root;
  const review = readStoreFile<{ questions: ReviewItem[] }>(scanDir, 'review.json', { questions: [] });
  const suggestions = readStoreFile<StoredSuggestion[]>(root, 'suggestions.json', []);
  const store = await loadScanFolder(scanDir);

  const cases: Case[] = [];
  for (const item of review.questions.filter((q) => q.answer === null)) {
    const suggestion = suggestions.filter((s) => s.questionId === item.id).sort((a, b) => b.askedAt - a.askedAt)[0] ?? null;
    const evidence = await gatherEvidence(store, item);
    const input = briefInputOf(item, suggestion?.suggestion ?? null, poolOfEvidence(evidence), linksOfEvidence(evidence));
    cases.push({ item, suggestion, input });
  }
  const toCall = cases.filter((c) => worthABrief(c.input));

  log(`Brief eval${dryRun ? ', dry run (no network, no key read)' : ', run'}. Model ${model}, prompt ${BRIEF_PROMPT_VERSION}, data ${data}.`);
  log(`Questions: ${cases.length}. With a suggestion and at least one quote the code found: ${toCall.length} (one call each). No call for ${cases.length - toCall.length}.`);
  for (const c of cases) {
    const why = !c.suggestion ? 'no suggestion' : c.input.quotes.length === 0 ? 'no quote of it found on its page' : `${c.input.quotes.length} quote${c.input.quotes.length === 1 ? '' : 's'}, ${c.input.state}`;
    log(`  ${c.item.id}  ${why}${worthABrief(c.input) ? '' : '  (no call)'}`);
  }

  if (dryRun) {
    let inTok = 0;
    toCall.forEach((c, i) => {
      const r = briefRequest(c.input);
      if (i === 0) { log(''); log('--- system prompt (the same for every call) ---'); log(r.system); }
      log(''); log(`--- user message: ${c.item.id} ---`); log(r.user);
      inTok += Math.ceil((r.system.length + r.user.length + JSON.stringify(r.schema).length) / CHARS_PER_TOKEN);
    });
    const outTok = toCall.length * ESTIMATED_BRIEF_TOKENS.output;
    log('');
    log(`Estimated input: ${inTok} tokens (rendered prompts and schema, characters / ${CHARS_PER_TOKEN}: a rough count).`);
    log(`Estimated output: ${outTok} tokens (assumed ${ESTIMATED_BRIEF_TOKENS.output} a call, thinking included).`);
    log(`Prices used: $${rates.input} in / $${rates.output} out per million tokens.`);
    log(`Estimated cost: ${usd(costOf({ inputTokens: inTok, outputTokens: outTok }, rates))}.`);
    return 0;
  }

  const apiKey = deps.env('ANTHROPIC_API_KEY');
  if (!apiKey) { log('ANTHROPIC_API_KEY must be set (in .env or the environment). Nothing was called.'); return 1; }
  const writer = deps.makeModel ? deps.makeModel(model, apiKey) : new ProviderBrief({ provider: new ClaudeProvider({ apiKey, model }) });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pause = deps.pauseMs ?? DEFAULT_PAUSE_MS;

  let spent = 0;
  let calls = 0;
  let aiBriefs = 0;
  let sentences = 0;
  let dropped = 0;
  for (const c of cases) {
    log('');
    log(`${c.item.id}  (${c.input.kind}, ${c.input.state})`);
    if (!worthABrief(c.input)) { log('  no call'); continue; }
    if (maxCost !== undefined && spent >= maxCost) { log(`  not asked: the calls made cost ${usd(spent)}, the --max-cost.`); continue; }
    const out = await writeBrief(c.input, writer);
    if (out.usage) { calls += 1; spent += out.costUsd ?? 0; }
    for (const line of show(out.brief)) log(line);
    for (const v of out.verdicts) {
      sentences += 1;
      if (!v.kept) dropped += 1;
      log(`    ${v.kept ? 'kept   ' : 'dropped'} ${v.part}: ${v.text}${v.why ? `   <- ${v.why}` : ''}`);
    }
    if (out.brief.writtenBy === 'ai') aiBriefs += 1;
    if (out.fellBack) log(`    fell back to the rules brief: ${out.fellBack}`);
    log(`    cost: ${out.costUsd === null ? 'unknown' : usd(out.costUsd)}${out.usage ? ` (${out.usage.inputTokens} in, ${out.usage.outputTokens} out)` : ''}`);
    if (out.usage === undefined && out.fellBack && /key|auth/i.test(out.fellBack)) { log('The key was refused. Stopped.'); return 1; }
    await sleep(pause);
  }
  log('');
  log(`Calls: ${calls}. Model briefs that passed the checks: ${aiBriefs} of ${toCall.length}. Sentences written: ${sentences}, dropped by the checks: ${dropped}.`);
  log(`Total cost: ${usd(spent)} (${model}).`);
  return 0;
}
