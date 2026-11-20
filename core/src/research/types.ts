// The research agent for split questions (step 12): a language model reads Home Depot pages, searches
// Home Depot, checks the catalog and searches the brand's own site, then proposes the bundle's parts.
// A proposal is never an answer (CLAUDE.md rule 4): nothing here writes to the store; verify.ts decides
// what the proposal is worth, and only the owner's Approve saves an answer, through the existing path.
//
// This file is the contract. The client tools (ResearchTools) are run by the extension in the owner's
// browser (R2); tests and the eval run them from recorded files. The loop (loop.ts) keeps every tool
// result in a ledger, the only text a quote may come from.

import type { NotJudged, TokenUsage } from '../judge/types';

// --- Client tools ---------------------------------------------------------------------------------

/** A tool that could not give its result. Shown to the model as an error; nothing enters the ledger. */
export interface ToolError {
  error: string;
}

/** One "name: value" row of a Home Depot page's specifications ("Included", "What's in the box", ...). */
export interface PageSpecification {
  name: string;
  value: string;
}

/** A Home Depot product page as text sections, read from the page's own data. */
export interface PageSections {
  title: string;
  /** Home Depot's model number for the product ("PCL500B"). */
  model: string;
  /** The page's highlight bullets, in page order (an "Includes: ..." line among them). */
  bullets: string[];
  description: string;
  specifications: PageSpecification[];
}

export interface HomeDepotPage {
  /** A stable id for the source, e.g. `hd-page:<itemId>`. The ledger may rename one already taken. */
  sourceId: string;
  /** Link text for a quote's source ("Home Depot page"). */
  label: string;
  /** The page's address: https://www.homedepot.com/... only. */
  url: string;
  sections: PageSections;
}

export interface HomeDepotSearchRow {
  title: string;
  brand: string;
  model: string;
  itemId: string;
  url: string;
}

export interface HomeDepotSearch {
  sourceId: string;
  label: string;
  /** The search page's address. */
  url: string;
  /** At most 10, in Home Depot's order. */
  results: HomeDepotSearchRow[];
}

/** A product the scan's catalog knows (the store's catalog records). `kind` is 'kit' for a kit. */
export interface CatalogEntry {
  brand: string;
  model: string;
  title: string;
  kind: 'kit' | 'part';
}

export interface CatalogLookup {
  sourceId: string;
  entries: CatalogEntry[];
}

/**
 * The client tools the research model may call. Each never throws for an expected failure (a refused
 * page, a timeout, no recording): it returns { error }. None of them spends a SerpApi search or reaches
 * Amazon. `signal` aborts a tool when the question's time runs out or the owner presses Stop.
 */
export interface ResearchTools {
  /** The full Home Depot product page by item id or address. Free, in the owner's browser. */
  readHomeDepotPage(input: { itemId?: string; url?: string }, signal?: AbortSignal): Promise<HomeDepotPage | ToolError>;
  /** Home Depot's own search: up to 10 results. Free, in the owner's browser. */
  searchHomeDepot(input: { query: string }, signal?: AbortSignal): Promise<HomeDepotSearch | ToolError>;
  /** Entries of the local catalog by model number or words. Local; never a fetch. */
  catalogLookup(input: { model?: string; query?: string }, signal?: AbortSignal): Promise<CatalogLookup | ToolError>;
}

// --- The ledger -----------------------------------------------------------------------------------

/**
 * Where a ledger entry came from. `stored`: the evidence the scan stored (the bundle's page, a kit's
 * page), given before any tool ran. `brand_site`: a web search result or a page web_fetch opened, on
 * ryobitools.com or dewalt.com (a subdomain included).
 */
export type LedgerKind = 'stored' | 'homedepot_page' | 'homedepot_search' | 'catalog' | 'brand_site';

/** One line of a source: what the model is shown, and what a quote is searched in (a quote never spans two lines). */
export interface LedgerLine {
  /** `page`: a line of a brand-site page's text, as web_fetch returned it (fix round 1). */
  field: 'title' | 'model' | 'bullet' | 'spec' | 'description' | 'result' | 'entry' | 'cited' | 'page';
  text: string;
  /** A search result's or catalog entry's model: the product the line is about. */
  model?: string;
  /** The line reads as words written to an AI (looksLikeInstruction). Shown as data, never evidence. */
  suspect?: true;
}

/** A product a source names with its model number in its own field: a page's model, a search row, a catalog entry. */
export interface LedgerProduct {
  brand: string | null;
  model: string;
  title: string;
  /** The product is a kit (catalog kind, or a page or row of a kit). Null when the source does not say. */
  kit: boolean | null;
}

export interface ResearchLedgerEntry {
  /** What the model names as a quote's source: `bundle`, `kit:<MODEL>`, or the tool's source id. */
  id: string;
  kind: LedgerKind;
  label: string;
  /** http or https only; null otherwise. */
  url: string | null;
  lines: LedgerLine[];
  /** Products this source names in a model field (see LedgerProduct): what makes a part model real. */
  products: LedgerProduct[];
  /** The source is the bundle's own Home Depot page (stored, or read by item id or model). */
  isBundle: boolean;
  /** A Home Depot page's own model (its product), when the entry is a page. */
  pageModel?: string;
}

// --- The answer -----------------------------------------------------------------------------------

export type ResearchDecision = 'parts' | 'choose' | 'none' | 'cannot_tell';

export interface ResearchQuote {
  quote: string;
  sourceId: string;
}

export interface ResearchPart {
  model: string;
  qty: number;
  /** The quotes that show the part: that it is in the bundle, which item of the Includes list it is, and its model. */
  quotes: ResearchQuote[];
}

/** The model's final answer, as the submit_answer tool's schema shapes it. Nothing in it is trusted until verify.ts has read it. */
export interface ResearchAnswer {
  /** Quotes for a choose, none or cannot_tell answer (a parts answer keeps its quotes on each part). */
  quotes: ResearchQuote[];
  parts: ResearchPart[];
  reason: string;
  decision: ResearchDecision;
  /** choose: the chosen reading's index into the question's choices; otherwise null. */
  choiceIndex: number | null;
}

// --- The model ------------------------------------------------------------------------------------

/** One request of the loop, whatever the provider: the adapter adds the model, effort and its own fields. */
export interface ResearchRequest {
  system: string;
  /** The tool definitions, in the Messages API's shape (client tools and the web search server tool). */
  tools: Record<string, unknown>[];
  /** The conversation so far, in the Messages API's shape. */
  messages: { role: 'user' | 'assistant'; content: unknown }[];
  maxTokens: number;
}

/** One response: its stop reason and content blocks as they came (sent back unchanged on the next request). */
export type ResearchTurn =
  | { ok: true; stopReason: string; content: unknown[]; usage: TokenUsage; stopDetails?: unknown }
  | { ok: false; notJudged: NotJudged; usage?: TokenUsage };

/** A model the loop can talk to. One call per request, no retries; never throws for a provider or network failure. */
export interface ResearchModel {
  readonly provider: string;
  readonly model: string;
  send(request: ResearchRequest, signal?: AbortSignal): Promise<ResearchTurn>;
}

/** Limits of one question's research (design: ≤ 8 tool calls, ≤ 2 web searches, 60 s, max_tokens 4000; fix round 1: ≤ 2 web fetches). */
export interface ResearchLimits {
  /** Client tool calls, web searches and web fetches together. */
  maxToolCalls: number;
  maxWebSearches: number;
  maxWebFetches: number;
  /** A fetched brand-site page is cut to about this many tokens (web_fetch max_content_tokens). */
  maxFetchTokens: number;
  timeLimitMs: number;
  maxTokens: number;
  /** Requests in one question, pause_turn continuations included. */
  maxRequests: number;
}

/** Usage of a whole question: every request's tokens summed, and the web searches and fetches run (fetches cost only their tokens). */
export interface ResearchUsage extends TokenUsage {
  webSearchRequests: number;
  webFetchRequests: number;
}
