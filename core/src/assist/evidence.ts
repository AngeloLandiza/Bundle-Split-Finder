// What a suggestion may rest on: the records the scan already stored, never a fetch and never a
// search. A split question rests on the bundle's own Home Depot page (title, model number, its
// specification lines and description) and the stored pages of the kits its readings name; a match
// question on its candidates' titles and Amazon's brand field. Each line keeps its source and link, so
// every quote the owner is shown can be checked against the page it came from.

import { kitIndex, kitRecords } from '../kitContents';
import { modelForms } from '../match';
import { choicesOf } from '../scan/answers';
import type { BundleRecord, CatalogRecord, ListingRecord, PageReading, ReviewItem, ScanStore } from '../scan/types';
import type { AssistEvidence, EvidenceLine, EvidenceNote, EvidenceSource } from './types';

/** A page's description is cut here, to bound cost; the cut part is not shown, so it cannot be quoted. */
export const MAX_EVIDENCE_DESCRIPTION_CHARS = 4000;

export const homeDepotUrl = (itemId: string): string => `https://www.homedepot.com/p/${itemId}`;
export const amazonUrl = (asin: string): string => `https://www.amazon.com/dp/${asin}`;

// The five entities the stored page text is seen to carry ("Battery &amp; Charger", 344285193). The
// model is shown the text as the page shows it, and quotes are checked against that same text.
const ENTITIES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>' };
const decode = (text: string): string => text.replace(/&(amp|quot|#39|apos|lt|gt);/g, (m) => ENTITIES[m]!);

// Words written to an AI rather than to a shopper. Each pattern names the reader (an AI, an assistant,
// a model) or the instructions themselves, or copies the answer's own shape or this prompt's tags; none
// is found in any recorded page or listing (assist-evidence.test.ts). A match only lowers: a suspect
// line is still shown, as data, but it is never evidence and while one is present no choice is verified.
const INSTRUCTION = [
  /\b(ignore|disregard|forget|override)\b[^.!?\n]{0,40}\b(instructions?|prompts?|rules|directions|above|previous|prior)\b/i,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /\byou are (an? |the )?(ai|assistant|language model|llm|chatbot|model)\b/i,
  /\bas an ai\b/i,
  /\b(ai|assistant|chatbot|llm|language model|claude|gpt|chatgpt)\b[^.!?\n]{0,30}\b(must|should|shall|answer|respond|reply|choose|select|pick|output|return)\b/i,
  /^\s*(assistant|system|user|human)\s*:/i,
  /\b(note|message|instructions?) (to|for) (the )?(ai|assistant|model|reviewer|llm)\b/i,
  /"\s*(decision|choiceIndex|asin|evidence)\s*"\s*:/i,
  /<\s*\/?\s*(question|readings?|evidence|source|candidates?|part|title|model_number|line|description|brand_field|notes?)\b[^>]*>/i,
];

/** Whether a page's text reads as words written to an AI (see INSTRUCTION). */
export const looksLikeInstruction = (text: string): boolean => INSTRUCTION.some((re) => re.test(text));

function line(field: EvidenceLine['field'], raw: string): EvidenceLine | null {
  const text = decode(raw).trim();
  if (text === '') return null;
  return looksLikeInstruction(text) ? { field, text, suspect: true } : { field, text };
}

const present = <T>(v: T | null): v is T => v !== null;

/** The lines of a page reading: its specification lines, then its description, cut. */
function pageLines(page: PageReading): EvidenceLine[] {
  const description = page.description === null ? null
    : page.description.length > MAX_EVIDENCE_DESCRIPTION_CHARS ? page.description.slice(0, MAX_EVIDENCE_DESCRIPTION_CHARS) : page.description;
  return [...page.bullets.map((b) => line('bullet', b)), description === null ? null : line('description', description)].filter(present);
}

const norm = (s: string): string => s.trim().toUpperCase();

/** A stored record a kit's page may be on (a bundle record, or a catalog entry marked a kit), with its title. */
export interface KitPageRecord {
  brand: string;
  model: string;
  title: string;
  itemId?: string | null;
  link?: string | null;
  page?: PageReading | null;
}

/**
 * The evidence for a split question: the bundle's page, then the newest stored page of each kit a
 * reading names, in the order the readings name them. `kits` are the stored records that may hold a
 * kit's page (kitRecords); the question's own bundle is never one of them.
 */
export function splitEvidence(item: ReviewItem, bundle: BundleRecord | undefined, kits: KitPageRecord[]): AssistEvidence {
  const missing: string[] = [];
  const bundleLines: EvidenceLine[] = [];
  if (bundle) {
    bundleLines.push(...[line('title', bundle.title), line('model', bundle.model)].filter(present));
    if (bundle.page) bundleLines.push(...pageLines(bundle.page));
    else missing.push("The bundle's Home Depot page was not read.");
  } else {
    missing.push("The bundle is not stored; only the question's title is known.");
    const title = item.title === null ? null : line('title', item.title);
    if (title) bundleLines.push(title);
  }
  const sources: EvidenceSource[] = [{
    id: 'bundle', kind: 'bundle', label: 'Home Depot page',
    url: bundle ? (bundle.link ?? homeDepotUrl(bundle.itemId)) : null,
    lines: bundleLines,
  }];

  const ownItemId = bundle?.itemId ?? item.subject.replace(/^homedepot:/, '');
  const of = kitIndex(kits.filter((k) => k.itemId !== ownItemId && !!k.page));
  const seen = new Set<string>();
  for (const model of choicesOf(item).flat()) {
    const m = norm(model);
    if (seen.has(m)) continue;
    seen.add(m);
    const newest = of(item.brand, m).sort((a, b) => b.page!.readAt - a.page!.readAt)[0];
    if (!newest) continue;
    sources.push({
      id: `kit:${m}`, kind: 'kit', label: `Home Depot page for ${m}`, model: m,
      url: newest.link ?? (newest.itemId ? homeDepotUrl(newest.itemId) : null),
      lines: [line('title', newest.title), ...pageLines(newest.page!)].filter(present),
    });
  }
  return { questionId: item.id, kind: 'split', brand: norm(item.brand), model: norm(item.model), modelForms: [norm(item.model)], sources, notes: [{ text: item.reason }], missing };
}

/**
 * The evidence for a match question: each candidate's title (and Amazon's brand field, when the
 * listing is stored), its ASIN and link, in the question's order. The tool's reasons are notes: they
 * help the model read the question but are not the listing's words, so they are never quotable.
 */
export function matchEvidence(item: ReviewItem, listings: ListingRecord[], part: Pick<CatalogRecord, 'title'> | undefined): AssistEvidence {
  const byAsin = new Map(listings.map((l) => [l.asin, l] as const));
  const sources: EvidenceSource[] = [];
  const notes: EvidenceNote[] = [{ text: item.reason }];
  for (const c of item.candidates) {
    const stored = byAsin.get(c.asin);
    sources.push({
      id: `listing:${c.asin}`, kind: 'listing', label: 'Amazon listing', asin: c.asin, url: amazonUrl(c.asin),
      lines: [line('title', c.title), stored?.brand ? line('brand', stored.brand) : null].filter(present),
    });
    for (const r of c.reasons) notes.push({ asin: c.asin, text: r });
  }
  return {
    questionId: item.id, kind: 'match', brand: norm(item.brand), model: norm(item.model), modelForms: modelForms(item.brand, item.model),
    partName: part?.title ?? null, sources, notes, missing: [],
  };
}

/** The evidence for a question, read from the store. Reads only; never a search or a fetch. */
export async function gatherEvidence(
  store: Pick<ScanStore, 'getBundle' | 'listBundles' | 'listCatalog' | 'getListing' | 'getCatalogEntry'>,
  item: ReviewItem,
): Promise<AssistEvidence> {
  if (item.kind === 'split') {
    const [bundle, bundles, catalog] = await Promise.all([store.getBundle(item.subject), store.listBundles(), store.listCatalog()]);
    return splitEvidence(item, bundle, kitRecords(bundles, catalog) as KitPageRecord[]);
  }
  const listings = (await Promise.all(item.candidates.map((c) => store.getListing(c.asin)))).filter((l): l is ListingRecord => l !== undefined);
  return matchEvidence(item, listings, await store.getCatalogEntry(item.subject));
}
