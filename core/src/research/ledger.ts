// The evidence ledger of one research question: every source the model was shown, line by line, with
// its link. The stored evidence (the bundle's page, kits' pages) goes in first; then every tool result
// and every brand-site search result, as it arrives. A quote counts only when it is found word for
// word in one line of the ledger entry it names (verify.ts), so the ledger is the whole of what a
// suggestion may rest on.
//
// Everything in the ledger is data. Lines that read as words written to an AI (looksLikeInstruction,
// as in Ask AI) are marked suspect: shown, never evidence, and while one is present nothing is verified.

import { looksLikeInstruction, MAX_EVIDENCE_DESCRIPTION_CHARS } from '../assist/evidence';
import type { AssistEvidence } from '../assist/types';
import type { CatalogLookup, HomeDepotPage, HomeDepotSearch, ResearchLedgerEntry, LedgerLine, LedgerProduct } from './types';

/** The brand sites the web search may reach (design: Home Depot and the brand's own site only). */
export const BRAND_SITE_DOMAINS = ['ryobitools.com', 'dewalt.com'] as const;

/** http and https addresses only; anything else is no link. */
export function safeUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Whether an address is on one of the brand sites (the domain or a subdomain of it). */
export function onBrandSite(url: string | null): boolean {
  if (url === null) return false;
  const host = new URL(url).hostname.toLowerCase();
  return BRAND_SITE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Whether an address is on homedepot.com. */
export function onHomeDepot(url: string | null): boolean {
  if (url === null) return false;
  const host = new URL(url).hostname.toLowerCase();
  return host === 'homedepot.com' || host.endsWith('.homedepot.com');
}

/** The item id in a Home Depot product address (/p/<words>/<itemId> or /p/<itemId>); null when there is none. */
export function itemIdOf(url: string | null): string | null {
  if (url === null) return null;
  return /\/p\/(?:[^/?#]+\/)?(\d{6,12})(?:[/?#]|$)/.exec(new URL(url).pathname + '/')?.[1] ?? null;
}

const norm = (s: string): string => s.trim().toUpperCase();

function line(field: LedgerLine['field'], raw: string, model?: string): LedgerLine | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return { field, text, ...(model ? { model: norm(model) } : {}), ...(looksLikeInstruction(text) ? { suspect: true as const } : {}) };
}
const present = <T>(v: T | null): v is T => v !== null;

/**
 * The specification rows that list what is in the box, read as an Includes list (verify.ts). Not
 * "Included": on the recorded pages (research-2026-11-20.json) it is a category ("Blade(s)", "Tool
 * Only", "Battery Included,Blade(s),Charger"), not a list of the box's items.
 */
export const INCLUDES_SPEC = /^\s*(includes|what'?s in the box|in the box|box contents|package contents)\s*$/i;

/** The bundle the question is about: its item id and model, to tell its own page from others. */
export interface BundleIdentity {
  brand: string;
  model: string;
  itemId: string | null;
}

/** The bundle of a split question: brand and model from the question, the item id from its subject (homedepot:<itemId>). */
export function bundleIdentity(item: { brand: string; model: string; subject: string }): BundleIdentity {
  const id = /^homedepot:(\d+)$/.exec(item.subject)?.[1] ?? null;
  return { brand: norm(item.brand), model: norm(item.model), itemId: id };
}

/** The stored evidence Ask AI gathers (gatherEvidence), as the ledger's first entries. */
export function ledgerFromEvidence(evidence: AssistEvidence): ResearchLedgerEntry[] {
  return evidence.sources.map((s): ResearchLedgerEntry => {
    const lines = s.lines.map((l) => line(l.field === 'brand' ? 'result' : l.field, l.text)).filter(present);
    const title = s.lines.find((l) => l.field === 'title')?.text ?? '';
    const isBundle = s.kind === 'bundle';
    const products: LedgerProduct[] = s.kind === 'kit' && s.model ? [{ brand: evidence.brand, model: norm(s.model), title, kit: true }] : [];
    return { id: s.id, kind: 'stored', label: s.label, url: safeUrl(s.url), lines, products, isBundle, ...(s.kind === 'kit' && s.model ? { pageModel: norm(s.model) } : {}) };
  });
}

/** A page read by read_homedepot_page. `asked` is the item id the model asked for, when it gave one. */
export function pageEntry(id: string, page: HomeDepotPage, bundle: BundleIdentity, asked: string | null): ResearchLedgerEntry {
  const s = page.sections;
  const url = safeUrl(page.url);
  const description = s.description.length > MAX_EVIDENCE_DESCRIPTION_CHARS ? s.description.slice(0, MAX_EVIDENCE_DESCRIPTION_CHARS) : s.description;
  const lines = [
    line('title', s.title),
    line('model', s.model),
    ...s.bullets.map((b) => line('bullet', b)),
    ...s.specifications.map((sp) => line('spec', `${sp.name}: ${sp.value}`)),
    line('description', description),
  ].filter(present);
  const model = norm(s.model);
  const itemId = itemIdOf(url) ?? asked;
  const isBundle = (bundle.itemId !== null && itemId === bundle.itemId) || (model !== '' && model === bundle.model);
  const kit = /\b(combo kit|starter kit|\d+[- ]tools?\b)/i.test(s.title) ? true : null;
  const products: LedgerProduct[] = model === '' || isBundle ? [] : [{ brand: null, model, title: s.title, kit }];
  return { id, kind: 'homedepot_page', label: page.label || 'Home Depot page', url, lines, products, isBundle, ...(model ? { pageModel: model } : {}) };
}

/** One search row as one line: the brand, the model and the item id in Home Depot's own fields, then its title. */
export const searchRowText = (r: { brand: string; model: string; itemId: string; title: string }): string =>
  `${r.brand} ${r.model} (item ${r.itemId}): ${r.title}`;

export function searchEntry(id: string, search: HomeDepotSearch): ResearchLedgerEntry {
  const rows = search.results.slice(0, 10);
  return {
    id, kind: 'homedepot_search', label: search.label || 'Home Depot search', url: safeUrl(search.url),
    lines: rows.map((r) => line('result', searchRowText(r), r.model)).filter(present),
    products: rows.filter((r) => r.model.trim() !== '').map((r) => ({ brand: norm(r.brand), model: norm(r.model), title: r.title, kit: null })),
    isBundle: false,
  };
}

export const catalogRowText = (e: { brand: string; model: string; title: string; kind: string }): string =>
  `${e.brand} ${e.model}${e.kind === 'kit' ? ' (kit)' : ''}: ${e.title}`;

export function catalogLedgerEntry(id: string, lookup: CatalogLookup): ResearchLedgerEntry {
  return {
    id, kind: 'catalog', label: 'Catalog', url: null,
    lines: lookup.entries.map((e) => line('entry', catalogRowText(e), e.model)).filter(present),
    products: lookup.entries.map((e) => ({ brand: norm(e.brand), model: norm(e.model), title: e.title, kit: e.kind === 'kit' })),
    isBundle: false,
  };
}

/**
 * A brand-site search result. Its page text reaches the model encrypted (the API passes it back
 * unread), so only what the code can read is quotable: the title, and the passages the model cited
 * from it (cited_text). Products are never taken from it: a brand-site model counts only when quoted.
 */
export function webEntry(id: string, result: { url: string; title: string; pageAge?: string | null }): ResearchLedgerEntry | null {
  const url = safeUrl(result.url);
  if (!onBrandSite(url)) return null;
  const host = new URL(url!).hostname.replace(/^www\./, '');
  return { id, kind: 'brand_site', label: host, url, lines: [line('title', result.title)].filter(present), products: [], isBundle: false };
}

/** Adds a passage the model cited from a brand-site result to that result's entry (once). */
export function addCited(entry: ResearchLedgerEntry, citedText: string): void {
  const l = line('cited', citedText);
  if (l && !entry.lines.some((x) => x.field === 'cited' && x.text === l.text)) entry.lines.push(l);
}

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,60}$/;

/**
 * The id a new entry gets: the tool's own source id when it has a plain shape and is not taken (and is
 * never `bundle` or `kit:...`, which name the stored evidence), else `<prefix>:<n>`.
 */
export function freshId(ledger: ResearchLedgerEntry[], wanted: string | undefined, prefix: string): string {
  const taken = new Set(ledger.map((e) => e.id.toLowerCase()));
  const w = (wanted ?? '').trim();
  if (ID_SHAPE.test(w) && !taken.has(w.toLowerCase()) && w.toLowerCase() !== 'bundle' && !/^kit:/i.test(w)) return w;
  for (let n = 1; ; n++) if (!taken.has(`${prefix}:${n}`)) return `${prefix}:${n}`;
}

// Tags of the rendered sources. Page text that writes one is defused, so it cannot end a source early
// and speak as the prompt.
const OWN_TAG = /<\s*\/?\s*(question|readings?|reading|evidence|sources?|title|model_number|line|spec|description|result|entry|cited|notes?|missing|bundle)\b[^>]*>/gi;
export const defuse = (text: string): string => text.replace(OWN_TAG, ' ');
const attr = (text: string): string => defuse(text).replace(/["<>]/g, ' ');

const TAG: Record<LedgerLine['field'], string> = {
  title: 'title', model: 'model_number', bullet: 'line', spec: 'spec', description: 'description', result: 'result', entry: 'entry', cited: 'cited',
};

const WHAT: Record<ResearchLedgerEntry['kind'], string> = {
  stored: 'a Home Depot page the scan stored',
  homedepot_page: 'a Home Depot product page',
  homedepot_search: 'Home Depot search results',
  catalog: 'catalog entries',
  brand_site: "a page of the brand's own site",
};

/** A ledger entry as the model reads it: a source block with its id, each line in its own tag. */
export function renderEntry(e: ResearchLedgerEntry): string {
  const what = e.isBundle ? "the bundle's own Home Depot page" : e.kind === 'stored' && e.pageModel ? `the Home Depot page of the kit ${e.pageModel}` : WHAT[e.kind];
  const out = [`<source id="${attr(e.id)}" is="${what}"${e.url ? ` url="${attr(e.url)}"` : ''}>`];
  for (const l of e.lines) out.push(`<${TAG[l.field]}>${defuse(l.text)}</${TAG[l.field]}>`);
  if (e.lines.length === 0) out.push('(nothing found)');
  out.push('</source>');
  return out.join('\n');
}
