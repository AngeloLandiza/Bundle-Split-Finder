// The research loop for one split question: a manual tool-use loop. Each request sends the fixed
// prompt, the tools and the conversation so far; the model calls client tools (run here through
// ResearchTools, their results kept in the ledger and sent back as data), the web search server tool
// (run by the API on the brand sites only; its results kept in the ledger too), and finally
// submit_answer. The answer is then checked by verifyResearch against the ledger.
//
// Limits a question (design): at most 8 tool calls (client calls and web searches together), 2 web
// searches (max_uses, and counted here), 60 seconds, max_tokens 4000 a request, 12 requests. A limit
// hit, a failed call, a refusal or Stop is `not_suggested` with its reason, never a partial answer.
// No retries. Nothing here writes to the store or spends a SerpApi search.

import { reviewSignature } from '../scan/answers';
import type { ReviewItem } from '../scan/types';
import type { AssistEvidence, Suggestion } from '../assist/types';
import { type ClaudeMessageBody, stopFailure } from '../judge/claude';
import type { NotJudged, TokenUsage } from '../judge/types';
import {
  addCited, addFetched, bundleIdentity, catalogLedgerEntry, freshId, ledgerFromEvidence, onHomeDepot, pageEntry, renderEntry, safeUrl, searchEntry, webEntry,
} from './ledger';
import { DEFAULT_RESEARCH_LIMITS, FOLLOW_UP_VERSION_SUFFIX, renderResearchInput, researchPromptFor, researchTools } from './prompt';
import type { CatalogEntry, ResearchLedgerEntry, ResearchAnswer, ResearchLimits, ResearchModel, ResearchRequest, ResearchTools, ResearchUsage } from './types';
import { parseResearchAnswer } from './schema';
import { verifyResearch } from './verify';

export interface ResearchOptions {
  /** The owner's Stop: aborts the request or tool in flight. */
  signal?: AbortSignal;
  limits?: Partial<ResearchLimits>;
  /** The catalog the scan knows, for whether a part's model is real (verify.ts). */
  catalog?: CatalogEntry[];
  /** Clock, for the time limit (tests). */
  now?: () => number;
  /**
   * Step 16, the follow-up loop (followUp.ts): a second ask of a question the first could not settle. `entries` are the pages
   * and searches the app read for it since (each with its link), given beside the stored evidence and quotable like any; `notes`
   * are the code's own sentences saying what was read and what is still missing. The answer is checked as any other.
   */
  followUp?: { entries: ResearchLedgerEntry[]; notes: string[] };
}

/** What the research did, kept with the suggestion: the ledger every quote was checked against, and its cost. */
export interface ResearchTrace {
  ledger: ResearchLedgerEntry[];
  /** Client tool calls made. */
  toolCalls: number;
  /** Web searches the model called (server_tool_use blocks). */
  webSearches: number;
  /** Brand-site pages the model opened with web_fetch (server_tool_use blocks; fix round 1). */
  webFetches: number;
  requests: number;
  usage: ResearchUsage;
  /** The model's answer as it gave it; null when there was none. */
  answer: ResearchAnswer | null;
  /** Brand-site results dropped because their address was not on an allowed domain (the API should never send one). */
  droppedResults: number;
  /**
   * Step 16: the client tools that failed to give a result (a page Home Depot refused, a search a cold tab could not run),
   * by tool name, once per failure. Absent when none failed. A wrong input the model gave is not a failure.
   */
  failedTools?: string[];
  /** Step 16: each failed client call with the input it was given, so the follow-up loop can make the same call once more. */
  failedCalls?: { tool: string; input: Record<string, unknown> }[];
}

/** One research result: a Suggestion (as Ask AI's, so the panel and the store take it as they are) and its trace. */
export type ResearchSuggestion = Suggestion & { research: ResearchTrace };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function addUsage(total: ResearchUsage, u: TokenUsage | undefined): void {
  if (!u) return;
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  if (u.cacheReadInputTokens !== undefined) total.cacheReadInputTokens = (total.cacheReadInputTokens ?? 0) + u.cacheReadInputTokens;
  if (u.cacheCreationInputTokens !== undefined) total.cacheCreationInputTokens = (total.cacheCreationInputTokens ?? 0) + u.cacheCreationInputTokens;
  total.webSearchRequests += u.webSearchRequests ?? 0;
  total.webFetchRequests += u.webFetchRequests ?? 0;
}

type ToolOutcome = { content: string; isError: boolean; failed?: true };

/**
 * Researches one split question and checks the answer. Makes no call for a question the owner has
 * answered or a match question. Never throws: a failed or stopped run is `not_suggested`.
 */
export async function researchQuestion(
  item: ReviewItem,
  evidence: AssistEvidence,
  tools: ResearchTools,
  model: ResearchModel,
  opts: ResearchOptions = {},
): Promise<ResearchSuggestion> {
  const limits: ResearchLimits = { ...DEFAULT_RESEARCH_LIMITS, ...opts.limits };
  const now = opts.now ?? (() => Date.now());
  const ledger: ResearchLedgerEntry[] = [];
  const usage: ResearchUsage = { inputTokens: 0, outputTokens: 0, webSearchRequests: 0, webFetchRequests: 0 };
  const trace: ResearchTrace = { ledger, toolCalls: 0, webSearches: 0, webFetches: 0, requests: 0, usage, answer: null, droppedResults: 0 };
  // A model without the brand-site server tools (an OpenAI-compatible one) is offered the Home Depot tools only, and told so.
  const web = model.webTools !== false;
  const { prompt, version: base } = researchPromptFor(web);
  const version = opts.followUp ? base + FOLLOW_UP_VERSION_SUFFIX : base;
  const who = model.label ?? 'Claude';
  const meta = { questionId: item.id, seen: reviewSignature(item), provider: model.provider, model: model.model, promptVersion: version };
  const withUsage = () => (usage.inputTokens + usage.outputTokens + usage.webSearchRequests > 0 ? { usage: { ...usage } } : {});
  const notSuggested = (reason: string, notJudged?: NotJudged): ResearchSuggestion => ({
    ...meta, status: 'not_suggested', reason, ...(notJudged ? { notSuggested: notJudged } : {}), ...withUsage(), research: trace,
  });

  if (item.answer !== null) return notSuggested('That question was already answered.');
  if (item.kind !== 'split') return notSuggested('Research is for split questions; a match question is asked as before.');
  if (evidence.questionId !== item.id || evidence.kind !== item.kind) return notSuggested('The evidence is for another question.');
  const named = (s: string): string => (who === 'Claude' ? s : s.split('Claude').join(who));
  if (opts.signal?.aborted) return notSuggested('Stopped before the research began.', { reason: 'aborted', message: named('The call to Claude was cancelled.') });

  ledger.push(...ledgerFromEvidence(evidence));
  for (const e of opts.followUp?.entries ?? []) if (!ledger.some((x) => x.id === e.id)) ledger.push({ ...e, lines: [...e.lines], products: [...e.products] });
  const bundle = bundleIdentity(item);
  const toolDefs = researchTools(limits, web);
  const messages: ResearchRequest['messages'] = [{ role: 'user', content: renderResearchInput(item, ledger, evidence.missing, limits, web, opts.followUp?.notes) }];

  // One signal for everything in flight: the owner's Stop or the question's time limit.
  const controller = new AbortController();
  let timedOut = false;
  const onStop = () => controller.abort();
  opts.signal?.addEventListener('abort', onStop);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.timeLimitMs);
  const deadline = now() + limits.timeLimitMs;
  // A limit is the research's own end, not a provider's failure and not the owner's Stop: it says so (reason 'limit'), so a queue can count it.
  const limit = (message: string): ResearchSuggestion => notSuggested(message, { reason: 'limit', message });
  const stopped = (): ResearchSuggestion | null => {
    if (timedOut || now() >= deadline) return limit(`The research ran past its time limit of ${Math.round(limits.timeLimitMs / 1000)} seconds before an answer.`);
    if (opts.signal?.aborted) return notSuggested('Stopped before an answer.', { reason: 'aborted', message: named('The call to Claude was cancelled.') });
    return null;
  };
  const overLimit = (): ResearchSuggestion | null =>
    trace.toolCalls + trace.webSearches + trace.webFetches > limits.maxToolCalls
      ? limit(`The research reached its limit of ${limits.maxToolCalls} tool calls before an answer.`)
      : trace.webSearches > limits.maxWebSearches
        ? limit(`The research reached its limit of ${limits.maxWebSearches} web searches before an answer.`)
        : trace.webFetches > limits.maxWebFetches
          ? limit(`The research reached its limit of ${limits.maxWebFetches} web fetches before an answer.`)
          : null;

  try {
    let answer: unknown = undefined;
    for (;;) {
      const halt = stopped();
      if (halt) return halt;
      if (trace.requests >= limits.maxRequests) return limit(`The research reached its limit of ${limits.maxRequests} requests before an answer.`);

      let turn;
      try {
        turn = await model.send({ system: prompt, tools: toolDefs, messages: [...messages], maxTokens: limits.maxTokens }, controller.signal);
      } catch {
        return stopped() ?? notSuggested('The model failed without an answer.');
      }
      trace.requests++;
      if (!turn.ok) {
        addUsage(usage, turn.usage);
        if (turn.notJudged.reason === 'aborted') return stopped() ?? notSuggested(turn.notJudged.message, turn.notJudged);
        return notSuggested(turn.notJudged.message, turn.notJudged);
      }
      addUsage(usage, turn.usage);
      absorbServerBlocks(turn.content, ledger, trace);
      const over = overLimit();
      if (over) return over;

      const body: ClaudeMessageBody = { stop_reason: turn.stopReason, content: turn.content, ...(turn.stopDetails !== undefined ? { stop_details: turn.stopDetails } : {}) };
      const failed = stopFailure(body, named('Claude declined to research this question.'));
      if (failed) {
        const f = { ...failed, message: named(failed.message) };
        return notSuggested(f.message, f);
      }

      const blocks = turn.content.filter(isRecord);
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const submit = toolUses.find((b) => b.name === 'submit_answer');
      if (submit) {
        answer = submit.input;
        break;
      }
      if (turn.stopReason === 'pause_turn') {
        // The API paused its own server-tool loop: the paused content goes back as it came.
        messages.push({ role: 'assistant', content: turn.content });
        continue;
      }
      if (turn.stopReason === 'tool_use' && toolUses.length > 0) {
        const results: Record<string, unknown>[] = [];
        for (const use of toolUses) {
          trace.toolCalls++;
          const limit = overLimit();
          if (limit) return limit;
          const halt2 = stopped();
          if (halt2) return halt2;
          const out = await runTool(use, tools, ledger, bundle, controller.signal);
          if (out.failed) {
            (trace.failedTools ??= []).push(String(use.name));
            (trace.failedCalls ??= []).push({ tool: String(use.name), input: isRecord(use.input) ? { ...use.input } : {} });
          }
          results.push({ type: 'tool_result', tool_use_id: String(use.id), content: out.content, ...(out.isError ? { is_error: true } : {}) });
        }
        messages.push({ role: 'assistant', content: turn.content }, { role: 'user', content: results });
        continue;
      }
      if (turn.stopReason === 'end_turn') {
        // No submit_answer: a plain-text JSON answer (the last text block; earlier ones carry citations) is read, and checked like any other.
        const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => (b.text as string).trim()).filter((t) => t !== '');
        const text = texts[texts.length - 1] ?? '';
        if (text === '') return notSuggested(named('Claude finished without an answer.'), { reason: 'no_answer', message: named('Claude’s answer had no text.') });
        answer = text;
        break;
      }
      return notSuggested(`${who} stopped for an unexpected reason (${turn.stopReason.slice(0, 40)}).`, {
        reason: 'unexpected_stop', message: `${who} stopped for an unexpected reason (${turn.stopReason.slice(0, 40)}).`,
      });
    }

    const parsed = parseResearchAnswer(answer);
    trace.answer = parsed.ok ? parsed.answer : null;
    return { ...meta, ...verifyResearch(answer, item, ledger, opts.catalog ?? []), ...withUsage(), research: trace };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onStop);
  }
}

/** Web search and web fetch calls and results, and the passages the model cited, into the ledger. */
function absorbServerBlocks(content: unknown[], ledger: ResearchLedgerEntry[], trace: ResearchTrace): void {
  for (const b of content.filter(isRecord)) {
    if (b.type === 'server_tool_use' && b.name === 'web_search') trace.webSearches++;
    if (b.type === 'server_tool_use' && b.name === 'web_fetch') trace.webFetches++;
    // A fetched brand page (web fetch tool page: content is a web_fetch_result holding a document; an
    // error is a web_fetch_tool_result_error). Only plain text is read; a PDF's base64 is not.
    if (b.type === 'web_fetch_tool_result' && isRecord(b.content) && b.content.type === 'web_fetch_result') {
      const doc = isRecord(b.content.content) ? b.content.content : {};
      const source = isRecord(doc.source) ? doc.source : {};
      const text = source.type === 'text' && typeof source.data === 'string' ? source.data : '';
      const url = typeof b.content.url === 'string' ? b.content.url : '';
      if (!addFetched(ledger, { url, title: typeof doc.title === 'string' ? doc.title : null, text }) && text !== '') trace.droppedResults++;
    }
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content.filter(isRecord)) {
        if (r.type !== 'web_search_result') continue;
        const url = safeUrl(r.url);
        // A brand-site result's source id is its address: the model sees no other name for it.
        if (url !== null && ledger.some((e) => e.id === url)) continue;
        const entry = url === null ? null : webEntry(url, { url, title: typeof r.title === 'string' ? r.title : '' });
        if (entry) ledger.push(entry);
        else trace.droppedResults++;
      }
    }
    if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations.filter(isRecord)) {
        const url = safeUrl(c.url);
        const entry = ledger.find((e) => e.kind === 'brand_site' && e.id === url);
        if (entry && typeof c.cited_text === 'string') addCited(entry, c.cited_text);
      }
    }
  }
}

const ITEM_ID = /^\d{6,12}$/;

/** Runs one client tool call. Every failure is an error result for the model, never a throw. */
async function runTool(use: Record<string, unknown>, tools: ResearchTools, ledger: ResearchLedgerEntry[], bundle: ReturnType<typeof bundleIdentity>, signal: AbortSignal): Promise<ToolOutcome> {
  const input = isRecord(use.input) ? use.input : {};
  const error = (message: string): ToolOutcome => ({ content: message, isError: true });
  const failed = (message: string): ToolOutcome => ({ content: message, isError: true, failed: true });
  const add = (entry: ResearchLedgerEntry): ToolOutcome => {
    // The same source read twice keeps its first id: a quote names it either way.
    const same = ledger.find((e) => e.kind === entry.kind && e.url === entry.url && JSON.stringify(e.lines) === JSON.stringify(entry.lines));
    if (same) return { content: renderEntry(same), isError: false };
    ledger.push(entry);
    return { content: renderEntry(entry), isError: false };
  };
  try {
    switch (use.name) {
      case 'read_homedepot_page': {
        const itemId = str(input.itemId);
        const url = safeUrl(str(input.url));
        if (itemId !== null && !ITEM_ID.test(itemId)) return error('An item id is the number at the end of a Home Depot product address.');
        if (itemId === null && (url === null || !onHomeDepot(url))) return error('Give a Home Depot item id or a homedepot.com address.');
        const res = await tools.readHomeDepotPage(itemId !== null ? { itemId } : { url: url! }, signal);
        if ('error' in res) return failed(`The page could not be read: ${res.error}`.slice(0, 300));
        if (!onHomeDepot(safeUrl(res.url))) return error('That is not a Home Depot page.');
        return add(pageEntry(freshId(ledger, res.sourceId, 'hd-page'), res, bundle, itemId));
      }
      case 'search_homedepot': {
        const query = str(input.query);
        if (query === null || query.length > 200) return error('Give a search of 1 to 200 characters.');
        const res = await tools.searchHomeDepot({ query }, signal);
        if ('error' in res) return failed(`The search could not be run: ${res.error}`.slice(0, 300));
        return add(searchEntry(freshId(ledger, res.sourceId, 'hd-search'), res));
      }
      case 'catalog_lookup': {
        const model = str(input.model);
        const query = str(input.query);
        if (model === null && query === null) return error('Give a model number or words to look up.');
        const res = await tools.catalogLookup({ ...(model !== null ? { model } : {}), ...(query !== null ? { query } : {}) }, signal);
        if ('error' in res) return failed(`The catalog could not be read: ${res.error}`.slice(0, 300));
        return add(catalogLedgerEntry(freshId(ledger, res.sourceId, 'catalog'), res));
      }
      default:
        return error(`There is no tool named ${String(use.name).slice(0, 40)}.`);
    }
  } catch {
    return failed('The tool failed.');
  }
}
