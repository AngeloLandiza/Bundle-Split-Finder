// Step 16, the follow-up loop: when research could not settle a split question (its answer is unverified or "cannot
// tell"), the app does what it would otherwise have told the owner to do. The code works out what is missing as machine
// tasks, only from structured records: the verifier's refusals (VerifyGap, verify.ts), the client calls that failed
// (ResearchTrace.failedCalls), the ask's `lacks` tags (reverify.ts lacksOf), the question's own readings and the
// ledger's products. Never from a sentence: not the verifier's, not the model's reason, not a brief's.
//
// Tasks, each free (the owner's Chrome reads Home Depot; the catalog is local):
//   confirm_model(brand, model)   Home Depot's search for brand + model, then the product page naming exactly that model
//   read_kit_page(model, itemId)  a kit part's own page, for which items are the kit's
//   read_bundle_page(itemId)      the bundle's own page, when its sections were not among the sources
//   tool_failed(tool, input)      the very client call that failed, made once more now
//   catalog_lookup(brand, model)  the catalog the scan stored (no Keepa, no SerpApi)
//
// A round: run the tasks and keep each result as evidence with its link; (i) check the answer again by code with what was
// read (no model call, the same verifier, lever 1's rules); (ii) only if still not verified and the evidence key changed,
// ask the research model ONE follow-up question that carries the new sources and the code's own words for the gap; its
// answer passes the same verifier as any answer. At most MAX_FOLLOW_UP_ROUNDS follow-up asks per question, each under the
// monthly AI cap. There is no new way to be verified: what verifyResearch verifies is all that is.
//
// Pure: no store, no clock but the one given, no network but the tools given (CLAUDE.md layout).

import type { CheckedSuggestion } from '../assist/types';
import { sameModel } from '../match';
import { choicesOf } from '../scan/answers';
import type { ReviewItem } from '../scan/types';
import { bundleIdentity, catalogLedgerEntry, freshId, pageEntry, searchEntry } from './ledger';
import type { ResearchSuggestion, ResearchTrace } from './loop';
import { ledgerHasText } from './reverify';
import type { CatalogEntry, HomeDepotPage, HomeDepotSearch, ResearchAnswer, ResearchLedgerEntry, ResearchTools, ToolError, VerifyGap } from './types';
import { verifyResearch } from './verify';

/** Follow-up asks per question, at most (each only on evidence no ask saw). */
export const MAX_FOLLOW_UP_ROUNDS = 2;
/** Chrome tasks run in one round, at most (each one or two reads); catalog lookups are local and not counted. */
export const MAX_TASKS_PER_ROUND = 6;

const up = (s: string): string => s.trim().toUpperCase();
const cut = (s: string, n = 120): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

export type FollowUpTool = 'search_homedepot' | 'read_homedepot_page' | 'catalog_lookup';

export type FollowUpTask =
  | { kind: 'confirm_model'; brand: string; model: string }
  | { kind: 'read_kit_page'; brand: string; model: string; itemId: string | null }
  | { kind: 'read_bundle_page'; itemId: string }
  | { kind: 'tool_failed'; tool: FollowUpTool; input: Record<string, unknown> }
  | { kind: 'catalog_lookup'; brand: string; model: string };

/** One thing the loop did, as the card says it ("Searched Home Depot for RYOBI A21701" / "found: 15-Piece Router Bit Set"). */
export interface FollowUpTried {
  what: string;
  result: string;
  url?: string;
}

/** What the loop has done for a question, kept with its live suggestion (StoredSuggestion.followUp). */
export interface FollowUpState {
  state: 'queued' | 'running' | 'done' | 'gave_up';
  /** What it is doing now, while running ("Reading Home Depot's page for A21701"). */
  doing?: string;
  tried: FollowUpTried[];
  /** Follow-up asks made. */
  rounds: number;
  /** The pages, searches and catalog entries the loop read, each with its link: the evidence it adds. */
  entries: ResearchLedgerEntry[];
  /** Keys of the tasks run (taskKey): a task is run once per question. */
  done: string[];
  /** Evidence keys a follow-up ask was made on (followUpKey): never asked twice on the same. */
  askedKeys: string[];
  /** Why it stopped short of a verified answer, in plain words; absent when done. */
  reason?: string;
  updatedAt: number;
}

export const freshFollowUp = (now: number): FollowUpState => ({ state: 'queued', tried: [], rounds: 0, entries: [], done: [], askedKeys: [], updatedAt: now });

export function taskKey(t: FollowUpTask): string {
  switch (t.kind) {
    case 'confirm_model': return `confirm:${up(t.brand)}:${up(t.model)}`;
    case 'read_kit_page': return `kit:${up(t.model)}`;
    case 'read_bundle_page': return `bundle:${t.itemId}`;
    case 'catalog_lookup': return `catalog:${up(t.brand)}:${up(t.model)}`;
    case 'tool_failed': return `tool:${t.tool}:${JSON.stringify(t.input, Object.keys(t.input).sort())}`;
  }
}

/** What a task does, as the card says it while it runs. */
export function taskDoing(t: FollowUpTask): string {
  switch (t.kind) {
    case 'confirm_model': return `Reading Home Depot's page for ${up(t.model)}`;
    case 'read_kit_page': return `Reading Home Depot's page for the kit ${up(t.model)}`;
    case 'read_bundle_page': return "Reading the bundle's Home Depot page";
    case 'catalog_lookup': return `Looking up ${up(t.model)} in the catalog`;
    case 'tool_failed': return t.tool === 'search_homedepot' ? 'Searching Home Depot again' : t.tool === 'read_homedepot_page' ? 'Reading a Home Depot page again' : 'Looking in the catalog again';
  }
}

// ---------------------------------------------------------------- what is missing, as tasks

export interface DeriveInput {
  item: ReviewItem;
  /** The live suggestion's check: its status, and its structured refusals when unverified. */
  checked: { status: string; gaps?: readonly VerifyGap[] };
  answer: ResearchAnswer | null;
  /** The ask's trace: its ledger and the calls that failed. Null when none was kept. */
  trace: Pick<ResearchTrace, 'ledger' | 'failedCalls'> | null;
  /** The ask's lacks tags (reverify.ts lacksOf), when stamped. */
  lacks?: readonly string[];
  /** What the loop read so far for this question. */
  fetched: readonly ResearchLedgerEntry[];
  catalog: readonly CatalogEntry[];
  /** A kit's Home Depot item id by its model, when the store knows it. */
  kitItemIds?: ReadonlyMap<string, string>;
  /** Task keys already run for the question. */
  done: ReadonlySet<string>;
}

const TOOLS: readonly FollowUpTool[] = ['search_homedepot', 'read_homedepot_page', 'catalog_lookup'];

/**
 * The tasks a not-settled answer needs, in the order they run: the catalog, the calls that failed, the bundle's page, kit
 * pages, then model pages. Each once per question (`done`). Empty for a verified, "none" or not-suggested answer.
 */
export function deriveTasks(input: DeriveInput): FollowUpTask[] {
  const { item, checked } = input;
  if (checked.status !== 'unverified' && checked.status !== 'cannot_tell') return [];
  const brand = up(item.brand);
  const known = [...(input.trace?.ledger ?? []), ...input.fetched];
  const confirmed = (m: string): boolean =>
    known.some((e) => e.products.some((p) => (p.brand === null || up(p.brand) === brand) && sameModel(brand, p.model, m)))
    || input.catalog.some((c) => up(c.brand) === brand && sameModel(brand, c.model, m));
  const pageOf = (m: string): boolean => known.some((e) => !e.isBundle && e.lines.length > 0 && e.pageModel !== undefined && sameModel(brand, e.pageModel, m));
  const bundleRead = known.some((e) => e.isBundle && e.lines.length > 0);
  const bundleId = /^homedepot:(\d+)$/.exec(item.subject)?.[1] ?? null;
  const isBundle = (m: string): boolean => sameModel(brand, m, item.model);

  const catalog: FollowUpTask[] = [];
  const failed: FollowUpTask[] = [];
  const bundle: FollowUpTask[] = [];
  const kits: FollowUpTask[] = [];
  const models: FollowUpTask[] = [];
  const confirm = (m: string) => { if (!isBundle(m) && !pageOf(m)) models.push({ kind: 'confirm_model', brand, model: up(m) }); };
  const kit = (m: string) => { if (!isBundle(m) && !pageOf(m)) kits.push({ kind: 'read_kit_page', brand, model: up(m), itemId: input.kitItemIds?.get(up(m)) ?? null }); };
  const readBundle = () => { if (!bundleRead && bundleId !== null) bundle.push({ kind: 'read_bundle_page', itemId: bundleId }); };

  // The verifier's own refusals.
  for (const g of checked.gaps ?? []) {
    if (g.code === 'model_unconfirmed') {
      if (!confirmed(g.model)) catalog.push({ kind: 'catalog_lookup', brand, model: up(g.model) });
      confirm(g.model);
    } else if (g.code === 'kind_unknown') confirm(g.model);
    else if (g.code === 'kit_contents') kit(g.model);
    else if (g.code === 'bundle_unread') readBundle();
    // untied and leftover: no read settles them by itself; the follow-up ask is told of them (followUpNotes).
  }
  // The calls that failed, made once more.
  for (const c of input.trace?.failedCalls ?? []) {
    if ((TOOLS as readonly string[]).includes(c.tool)) failed.push({ kind: 'tool_failed', tool: c.tool as FollowUpTool, input: c.input });
  }
  // The ask's lacks: a stored source that was missing, a kit whose page was not stored.
  for (const l of input.lacks ?? []) {
    if (l.startsWith('missing:')) readBundle();
    else if (l.startsWith('kit:')) kit(l.slice(4));
  }
  if (!bundleRead) readBundle();
  // The models the question's readings and the answer name that no source shows: Home Depot's page says what each is.
  const named = [...choicesOf(item).flat(), ...(input.answer?.decision === 'parts' ? input.answer.parts.map((p) => p.model) : [])];
  for (const m of new Set(named.map(up).filter((m) => m !== ''))) if (!confirmed(m)) confirm(m);

  const out: FollowUpTask[] = [];
  const keys = new Set<string>();
  // A failed search for exactly "<brand> <model>" of a model the question names is the search confirm_model makes: made
  // once, by it (or not at all, once a source shows the model).
  const gapModels = (checked.gaps ?? []).flatMap((g) => ('model' in g ? [g.model] : []));
  const confirmQueries = new Set([...named, ...gapModels].map((m) => `${brand} ${up(m)}`.toLowerCase()));
  for (const t of [...catalog, ...failed, ...bundle, ...kits, ...models]) {
    if (t.kind === 'tool_failed' && t.tool === 'search_homedepot' && typeof t.input.query === 'string' && confirmQueries.has(t.input.query.trim().replace(/\s+/g, ' ').toLowerCase())) continue;
    if (t.kind === 'tool_failed' && t.tool === 'read_homedepot_page' && bundleId !== null && t.input.itemId === bundleId && bundle.length > 0) continue;
    const k = taskKey(t);
    if (keys.has(k) || input.done.has(k)) continue;
    // A kit page read is also its model's page: no separate confirm for it.
    if (t.kind === 'confirm_model' && keys.has(`kit:${up(t.model)}`)) continue;
    keys.add(k);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- running them

/** What one task found, in structured form: the sources it added, and whether it found the product it looked for. */
export interface TaskOutcome {
  task: FollowUpTask;
  sourceIds: string[];
  /** The product's own page or catalog entry was found (confirm_model, read_kit_page, catalog_lookup); null when the task looks for none. */
  found: boolean | null;
  failed: boolean;
}

export interface TasksResult {
  entries: ResearchLedgerEntry[];
  tried: FollowUpTried[];
  outcomes: TaskOutcome[];
  done: string[];
}

const isError = (v: unknown): v is ToolError => typeof v === 'object' && v !== null && 'error' in v;
const errText = (e: ToolError): string => cut(e.error, 80);

/**
 * Runs the tasks one after another, never throwing: a failed read is a line of `tried`, and nothing enters the evidence.
 * `toolsFor` gives each task its own set of tools (a question's set allows only a few reads). `known` is the ledger so far,
 * for fresh source ids. `onTask` is told each task as it starts.
 */
export async function runFollowUpTasks(
  tasks: readonly FollowUpTask[], toolsFor: () => ResearchTools, item: ReviewItem, known: readonly ResearchLedgerEntry[],
  opts: { signal?: AbortSignal; onTask?: (t: FollowUpTask) => void } = {},
): Promise<TasksResult> {
  let tools: ResearchTools = toolsFor();
  const out: TasksResult = { entries: [], tried: [], outcomes: [], done: [] };
  const bundle = bundleIdentity(item);
  const brand = up(item.brand);
  const all = (): ResearchLedgerEntry[] => [...known, ...out.entries];
  const add = (e: ResearchLedgerEntry): string => {
    out.entries.push(e);
    return e.id;
  };
  const fid = (sourceId: string, prefix: string): string => freshId(all(), `fu-${sourceId}`.slice(0, 60), prefix);
  const safe = async <T>(fn: () => Promise<T | ToolError>): Promise<T | ToolError> => {
    try {
      return await fn();
    } catch {
      return { error: 'The tool failed.' };
    }
  };
  const readPage = async (itemId: string): Promise<HomeDepotPage | ToolError> => safe(() => tools.readHomeDepotPage({ itemId }, opts.signal));
  const search = async (query: string): Promise<HomeDepotSearch | ToolError> => safe(() => tools.searchHomeDepot({ query }, opts.signal));

  /** Home Depot's search for brand + model, then the page of the one row whose own model field is the model. */
  const modelPage = async (b: string, m: string, what: string): Promise<{ ids: string[]; found: boolean; failed: boolean }> => {
    const q = `${b} ${m}`;
    const res = await search(q);
    if (isError(res)) {
      out.tried.push({ what: `Searched Home Depot for ${q}`, result: `the search failed: ${errText(res)}` });
      return { ids: [], found: false, failed: true };
    }
    const ids = [add(searchEntry(fid(res.sourceId, 'fu-search'), res))];
    const row = res.results.find((r) => up(r.brand) === b && up(r.model) === m) ?? res.results.find((r) => up(r.brand) === b && sameModel(b, r.model, m));
    if (!row || !/^\d{6,12}$/.test(row.itemId)) {
      out.tried.push({ what: `Searched Home Depot for ${q}`, result: 'no product with that model number', url: res.url });
      return { ids, found: false, failed: false };
    }
    const page = await readPage(row.itemId);
    if (isError(page) || !sameModel(b, page.sections.model, m)) {
      out.tried.push({ what: `${what} ${m}`, result: `found: ${cut(row.title, 90)} (its page could not be read)`, url: row.url });
      return { ids, found: true, failed: isError(page) };
    }
    ids.push(add(pageEntry(fid(page.sourceId, 'fu-page'), page, bundle, row.itemId)));
    out.tried.push({ what: `${what} ${m}`, result: `found: ${cut(page.sections.title, 90)}`, url: page.url });
    return { ids, found: true, failed: false };
  };

  for (const t of tasks) {
    if (opts.signal?.aborted) break;
    tools = toolsFor();
    opts.onTask?.(t);
    out.done.push(taskKey(t));
    if (t.kind === 'confirm_model') {
      const r = await modelPage(up(t.brand), up(t.model), 'Searched Home Depot for');
      out.outcomes.push({ task: t, sourceIds: r.ids, found: r.found, failed: r.failed });
    } else if (t.kind === 'read_kit_page') {
      if (t.itemId !== null) {
        const page = await readPage(t.itemId);
        if (isError(page)) {
          out.tried.push({ what: `Read Home Depot's page for the kit ${up(t.model)}`, result: `the page could not be read: ${errText(page)}` });
          out.outcomes.push({ task: t, sourceIds: [], found: false, failed: true });
        } else {
          const id = add(pageEntry(fid(page.sourceId, 'fu-page'), page, bundle, t.itemId));
          out.tried.push({ what: `Read Home Depot's page for the kit ${up(t.model)}`, result: `found: ${cut(page.sections.title, 90)}`, url: page.url });
          out.outcomes.push({ task: t, sourceIds: [id], found: sameModel(brand, page.sections.model, t.model), failed: false });
        }
      } else {
        const r = await modelPage(up(t.brand), up(t.model), 'Searched Home Depot for the kit');
        out.outcomes.push({ task: t, sourceIds: r.ids, found: r.found, failed: r.failed });
      }
    } else if (t.kind === 'read_bundle_page') {
      const page = await readPage(t.itemId);
      if (isError(page)) {
        out.tried.push({ what: "Read the bundle's Home Depot page", result: `the page could not be read: ${errText(page)}` });
        out.outcomes.push({ task: t, sourceIds: [], found: null, failed: true });
      } else {
        const id = add(pageEntry(fid(page.sourceId, 'fu-page'), page, bundle, t.itemId));
        out.tried.push({ what: "Read the bundle's Home Depot page", result: `read: ${page.sections.bullets.length} lines of highlights and Includes`, url: page.url });
        out.outcomes.push({ task: t, sourceIds: [id], found: null, failed: false });
      }
    } else if (t.kind === 'catalog_lookup') {
      const res = await safe(() => tools.catalogLookup({ model: up(t.model) }, opts.signal));
      const hits = isError(res) ? [] : res.entries.filter((e) => up(e.brand) === up(t.brand) && sameModel(up(t.brand), e.model, t.model));
      if (isError(res) || hits.length === 0) {
        out.tried.push({ what: `Looked up ${up(t.brand)} ${up(t.model)} in the catalog`, result: isError(res) ? `the catalog could not be read: ${errText(res)}` : 'not in the catalog' });
        out.outcomes.push({ task: t, sourceIds: [], found: false, failed: isError(res) });
      } else {
        const id = add(catalogLedgerEntry(fid(res.sourceId, 'fu-catalog'), { ...res, entries: hits }));
        out.tried.push({ what: `Looked up ${up(t.brand)} ${up(t.model)} in the catalog`, result: `found: ${cut(hits[0]!.title, 90)}` });
        out.outcomes.push({ task: t, sourceIds: [id], found: true, failed: false });
      }
    } else {
      // tool_failed: the same call, once more.
      const what = t.tool === 'search_homedepot' ? `Searched Home Depot again for ${cut(String(t.input.query ?? ''), 60)}`
        : t.tool === 'read_homedepot_page' ? `Read a Home Depot page again (${cut(String(t.input.itemId ?? t.input.url ?? ''), 60)})`
          : `Looked in the catalog again for ${cut(String(t.input.model ?? t.input.query ?? ''), 60)}`;
      let res: HomeDepotSearch | HomeDepotPage | ToolError | Awaited<ReturnType<ResearchTools['catalogLookup']>>;
      if (t.tool === 'search_homedepot') res = typeof t.input.query === 'string' ? await search(t.input.query) : { error: 'no query was kept' };
      else if (t.tool === 'read_homedepot_page') {
        const itemId = typeof t.input.itemId === 'string' ? t.input.itemId : null;
        const url = typeof t.input.url === 'string' ? t.input.url : null;
        res = itemId !== null || url !== null ? await safe(() => tools.readHomeDepotPage(itemId !== null ? { itemId } : { url: url! }, opts.signal)) : { error: 'no page was kept' };
      } else {
        const model = typeof t.input.model === 'string' ? t.input.model : undefined;
        const query = typeof t.input.query === 'string' ? t.input.query : undefined;
        res = await safe(() => tools.catalogLookup({ ...(model ? { model } : {}), ...(query ? { query } : {}) }, opts.signal));
      }
      if (isError(res)) {
        out.tried.push({ what, result: `it failed again: ${errText(res)}` });
        out.outcomes.push({ task: t, sourceIds: [], found: null, failed: true });
        continue;
      }
      let id: string;
      let result: string;
      let url: string | undefined;
      if ('results' in res) {
        id = add(searchEntry(fid(res.sourceId, 'fu-search'), res));
        result = res.results.length === 0 ? 'no results' : `${res.results.length} results`;
        url = res.url;
      } else if ('sections' in res) {
        id = add(pageEntry(fid(res.sourceId, 'fu-page'), res, bundle, typeof t.input.itemId === 'string' ? t.input.itemId : null));
        result = `found: ${cut(res.sections.title, 90)}`;
        url = res.url;
      } else {
        id = add(catalogLedgerEntry(fid(res.sourceId, 'fu-catalog'), res));
        result = res.entries.length === 0 ? 'nothing in the catalog' : `${res.entries.length} catalog entries`;
      }
      out.tried.push({ what, result, ...(url ? { url } : {}) });
      out.outcomes.push({ task: t, sourceIds: [id], found: null, failed: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the evidence key, the code's check, the question

/**
 * What the loop has read, as one string: a follow-up ask is made only on a key no ask saw. A search that found nothing counts
 * (that Home Depot shows no such model is news to the model); a read that failed left no entry and does not.
 */
export function followUpKey(entries: readonly ResearchLedgerEntry[]): string {
  return JSON.stringify(entries
    .map((e) => `${e.kind}:${e.url ?? e.id}:${e.lines.length}:${e.products.map((p) => up(p.model)).sort().join('|')}`).sort());
}

/**
 * (i) The answer checked again by code with what the loop read: no model call. As lever 1 (reverify.ts): a page or search
 * row of a model is a reading (its products only, never quotable: the model never saw it), a kit's page among the answer's
 * parts keeps its lines (its Includes say which items are the kit's), the bundle's page joins only when the ask had none.
 * The verifier is the same; null when the answer is not a parts answer or the ledger kept no text.
 */
export function recheckWithFollowUp(input: {
  item: ReviewItem; answer: ResearchAnswer | null; ledger: readonly ResearchLedgerEntry[]; catalog: readonly CatalogEntry[]; entries: readonly ResearchLedgerEntry[];
}): CheckedSuggestion | null {
  const { item, answer, catalog } = input;
  if (!answer || answer.decision !== 'parts' || !ledgerHasText(input.ledger)) return null;
  const brand = up(item.brand);
  const ledger: ResearchLedgerEntry[] = input.ledger.map((e) => ({ ...e, lines: [...e.lines], products: [...e.products] }));
  const hadBundle = ledger.some((e) => e.isBundle && e.lines.length > 0);
  const kitParts = answer.parts.map((p) => up(p.model)).filter((m) =>
    catalog.some((c) => c.kind === 'kit' && up(c.brand) === brand && sameModel(brand, c.model, m))
    || [...ledger, ...input.entries].some((e) => e.products.some((x) => x.kit === true && sameModel(brand, x.model, m))));
  for (const e of input.entries) {
    if (ledger.some((x) => x.id === e.id)) continue;
    if (e.isBundle) {
      if (!hadBundle) ledger.push({ ...e, lines: [...e.lines], products: [] });
      continue;
    }
    if (e.kind === 'homedepot_page' && e.pageModel !== undefined && kitParts.some((m) => sameModel(brand, e.pageModel!, m))) {
      ledger.push({ ...e, lines: [...e.lines], products: [...e.products] });
      continue;
    }
    if (e.products.length === 0) continue;
    ledger.push({ id: e.id, kind: 'reading', label: e.label, url: e.url, lines: [], products: [...e.products], isBundle: false });
  }
  return verifyResearch(answer, item, ledger, [...catalog]);
}

const GAP_NOTE: { [K in VerifyGap['code']]: (g: Extract<VerifyGap, { code: K }>) => string } = {
  model_unconfirmed: (g) => `- No source the first ask read gives the model ${g.model}.`,
  kind_unknown: (g) => `- What ${g.model} is (a tool, a battery, a charger, an accessory) could not be read from its names.`,
  kit_contents: (g) => `- The kit ${g.model}'s own page was not read, so which of the bundle's items are the kit's was not known.`,
  untied: (g) => `- Nothing tied ${g.model} to this bundle: the bundle's own page, or a listing of this same bundle, must name it.`,
  leftover: () => "- An item of the bundle's Includes lists was left over: no part accounted for it.",
  bundle_unread: () => "- The bundle's own page was not among the sources.",
};

/**
 * The follow-up question, in the code's own words: what the first ask came to, which sources the app read since (by
 * source id and model, never a page's words: those are in the evidence, as data), what each found, and what the check
 * found still missing. Every line comes from structured records.
 */
export function followUpNotes(input: {
  prior: { status: string; gaps?: readonly VerifyGap[] };
  entries: readonly ResearchLedgerEntry[];
  outcomes: readonly TaskOutcome[];
}): string[] {
  const out: string[] = [];
  out.push(input.prior.status === 'cannot_tell'
    ? 'An earlier ask of this question answered cannot_tell.'
    : "An earlier ask of this question gave an answer the app's check could not confirm.");
  out.push('Since then the app read these sources for it (they are in the evidence below, with ids starting "fu-"):');
  for (const e of input.entries) {
    const what = e.isBundle ? "the bundle's own Home Depot page"
      : e.kind === 'homedepot_page' ? `the Home Depot product page of ${e.pageModel ?? 'a product'}`
        : e.kind === 'homedepot_search' ? `a Home Depot search, ${e.lines.length} results`
          : e.kind === 'catalog' ? `catalog entries (${e.products.map((p) => up(p.model)).join(', ')})` : 'a source';
    out.push(`- ${e.id}: ${what}.`);
  }
  for (const o of input.outcomes) {
    if ((o.task.kind === 'confirm_model' || o.task.kind === 'read_kit_page') && o.found === false && !o.failed) {
      out.push(`- ${up(o.task.model)}: Home Depot's search shows no product with this model number.`);
    }
  }
  const gaps = input.prior.gaps ?? [];
  if (gaps.length > 0) {
    out.push("What the app's check of the earlier answer found missing:");
    const seen = new Set<string>();
    for (const g of gaps) {
      const line = (GAP_NOTE[g.code] as (x: VerifyGap) => string)(g);
      if (!seen.has(line)) out.push(line);
      seen.add(line);
    }
  }
  out.push('Which parts does the bundle hold? Use the new sources as you would any other, by their ids. If they still do not settle it, answer cannot_tell.');
  return out;
}

// ---------------------------------------------------------------- the loop

/** One follow-up ask: a research run with the loop's sources and question (loop.ts ResearchOptions.followUp). */
export type FollowUpAsk = (followUp: { entries: ResearchLedgerEntry[]; notes: string[] }, signal?: AbortSignal) => Promise<{ suggestion: ResearchSuggestion; costUsd: number | null }>;

/** Where the loop starts: the live suggestion's check, its answer and its trace. */
export interface FollowUpStart {
  checked: { status: string; gaps?: readonly VerifyGap[] };
  answer: ResearchAnswer | null;
  trace: ResearchTrace | null;
  lacks?: readonly string[];
}

export interface FollowUpRun {
  item: ReviewItem;
  catalog: readonly CatalogEntry[];
  kitItemIds?: ReadonlyMap<string, string>;
  start: FollowUpStart;
  /** What an earlier run of the loop for this question left: its reads count, its tasks are not run again. */
  prior?: FollowUpState;
  /** A set of tools, asked for once per task (a question's set allows only a few reads). */
  tools: () => ResearchTools;
  /** The follow-up ask, or null when the loop may only read (free) and check by code. */
  ask: FollowUpAsk | null;
  /** What one ask may cost (null: no known price, so none is made), what the month has cost, and the cap. */
  estimateUsd: number | null;
  spentUsd: number;
  capUsd: number;
  signal?: AbortSignal;
  now: () => number;
  /** Told the state as it changes (the agent keeps it, so the card shows what the app is doing). */
  progress?: (state: FollowUpState) => void;
}

export interface FollowUpResult {
  state: FollowUpState;
  /** (i) The code's check again, when it verified the answer with what was read: no model call. */
  rechecked: CheckedSuggestion | null;
  /** (ii) Each follow-up ask made, in order, with its cost and the evidence key it was asked on. */
  asks: { suggestion: ResearchSuggestion; costUsd: number | null; evidenceKey: string }[];
  costUsd: number;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Runs the loop for one question. Never throws; every answer it keeps passed verifyResearch. */
export async function runFollowUp(run: FollowUpRun): Promise<FollowUpResult> {
  const state: FollowUpState = run.prior
    ? { ...run.prior, state: 'running', tried: [...run.prior.tried], entries: [...run.prior.entries], done: [...run.prior.done], askedKeys: [...run.prior.askedKeys], updatedAt: run.now() }
    : { ...freshFollowUp(run.now()), state: 'running' };
  delete state.reason;
  const result: FollowUpResult = { state, rechecked: null, asks: [], costUsd: 0 };
  const tell = (doing?: string) => {
    if (doing === undefined) delete state.doing;
    else state.doing = doing;
    state.updatedAt = run.now();
    run.progress?.({ ...state, tried: [...state.tried] });
  };
  const end = (s: 'done' | 'gave_up', reason?: string): FollowUpResult => {
    state.state = s;
    delete state.doing;
    if (reason) state.reason = reason;
    state.updatedAt = run.now();
    run.progress?.({ ...state, tried: [...state.tried] });
    return result;
  };
  let cur = run.start;
  let spent = run.spentUsd;
  for (;;) {
    if (run.signal?.aborted) return end('gave_up', 'Stopped before the follow-up finished.');
    const tasks = deriveTasks({
      item: run.item, checked: cur.checked, answer: cur.answer, trace: cur.trace, ...(cur.lacks ? { lacks: cur.lacks } : {}), fetched: state.entries,
      catalog: run.catalog, ...(run.kitItemIds ? { kitItemIds: run.kitItemIds } : {}), done: new Set(state.done),
    });
    const chrome = tasks.filter((t) => t.kind !== 'catalog_lookup').slice(0, MAX_TASKS_PER_ROUND);
    tasks.splice(0, tasks.length, ...tasks.filter((t) => t.kind === 'catalog_lookup' || chrome.includes(t)));
    let outcomes: TaskOutcome[] = [];
    if (tasks.length > 0) {
      tell(taskDoing(tasks[0]!));
      const r = await runFollowUpTasks(tasks, run.tools, run.item, [...(cur.trace?.ledger ?? []), ...state.entries], { ...(run.signal ? { signal: run.signal } : {}), onTask: (t) => tell(taskDoing(t)) });
      state.entries.push(...r.entries);
      state.tried.push(...r.tried);
      state.done.push(...r.done);
      outcomes = r.outcomes;
      tell(undefined);
      // (i) The code's check again with what was read: no model call.
      if (r.entries.length > 0) {
        const rc = recheckWithFollowUp({ item: run.item, answer: cur.answer, ledger: cur.trace?.ledger ?? [], catalog: run.catalog, entries: state.entries });
        if (rc?.status === 'verified') {
          result.rechecked = rc;
          return end('done');
        }
      }
    }
    const key = followUpKey(state.entries);
    if (state.entries.length === 0 || state.askedKeys.includes(key)) {
      return end('gave_up', state.tried.length === 0 ? 'Nothing the app can read would settle this.' : 'The app read what it could; nothing new to ask the AI about.');
    }
    if (run.ask === null) return end('gave_up', 'The app read the pages; asking the AI again with them is off.');
    if (state.rounds >= MAX_FOLLOW_UP_ROUNDS) return end('gave_up', `The AI was asked again ${MAX_FOLLOW_UP_ROUNDS} times with what the app read, and it is still not settled.`);
    if (run.estimateUsd === null) return end('gave_up', 'No price is known for the research model, so it was not asked again.');
    if (spent + run.estimateUsd > run.capUsd) return end('gave_up', `This month's AI limit of ${usd(run.capUsd)} is reached.`);
    // (ii) One follow-up question with the new sources and the gap, in the code's own words.
    tell('Asking the AI again with what the app read');
    const notes = followUpNotes({ prior: cur.checked, entries: state.entries, outcomes });
    // The sources the earlier ask read with its own tools come along too (it quoted from them; the model sees them again),
    // then what the loop read. The stored evidence is added by the research run itself.
    const carried = (cur.trace?.ledger ?? []).filter((e) => e.kind !== 'stored' && e.kind !== 'reading' && e.lines.length > 0);
    const given = [...carried, ...state.entries.filter((e) => !carried.some((c) => c.id === e.id))];
    let asked;
    try {
      asked = await run.ask({ entries: given.map((e) => ({ ...e, lines: [...e.lines], products: [...e.products] })), notes }, run.signal);
    } catch {
      return end('gave_up', 'The follow-up ask failed.');
    }
    state.rounds += 1;
    state.askedKeys.push(key);
    const cost = asked.costUsd ?? 0;
    spent += cost;
    result.costUsd += cost;
    result.asks.push({ ...asked, evidenceKey: key });
    const s = asked.suggestion;
    state.tried.push({ what: 'Asked the AI again with what the app read', result: s.status === 'verified' ? 'its answer passed the checks' : s.status === 'cannot_tell' ? 'it still could not tell' : s.status === 'not_suggested' ? 'no answer came back' : 'its answer did not pass the checks' });
    if (s.status === 'verified') return end('done');
    if (s.status === 'not_suggested') return end('gave_up', s.reason);
    if (s.status === 'none_suggested') return end('gave_up', 'The AI said none of the readings fits; that is never taken without you.');
    cur = { checked: s, answer: s.research.answer, trace: s.research };
  }
}

// ---------------------------------------------------------------- what the card shows

/** ReviewQuestion.followUp (GET /api/review): what the app is doing, or did, about a question before it is the owner's. */
export interface ReviewFollowUp {
  state: FollowUpState['state'];
  /** "Reading Home Depot's page for A21701", while it runs. */
  doing?: string;
  /** "Searched Home Depot for RYOBI A21701" / "found: 15-Piece Router Bit Set", with the page's link. */
  tried: FollowUpTried[];
  roundsLeft: number;
}

export function followUpView(s: FollowUpState): ReviewFollowUp {
  return {
    state: s.state,
    ...(s.doing && (s.state === 'queued' || s.state === 'running') ? { doing: s.doing } : {}),
    tried: s.tried.map((t) => ({ ...t })),
    roundsLeft: Math.max(0, MAX_FOLLOW_UP_ROUNDS - s.rounds),
  };
}

/** Whether the question is the app's for now (not counted in "Needs you"). */
export const followUpWorking = (s: FollowUpState | undefined): boolean => s !== undefined && (s.state === 'queued' || s.state === 'running');
