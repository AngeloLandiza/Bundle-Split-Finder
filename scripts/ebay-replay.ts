// eBay and the listing judge's model, answered from recordings. Never opens a socket and never spends: the
// worker's tests and the end-to-end replay server serve these in place of api.ebay.com and api.anthropic.com.
//
// eBay: fixtures/ebay/validation-2026-11-19.json holds the parsed listings of the real searches and item reads
// (no seller field, ever); browseSearch and browseItem write them back in the shape of eBay's Browse API, which
// core/src/ebay/parse reads again.
//
// The model: a canned answer chosen from the recording, never computed from the listing's text by any rule that
// could pass for judging. cannedAnswer says which listings are a match, which are unsure and which are not, by
// item id, for the parts a spec uses; every other listing is "not_match".

import { readFileSync } from 'node:fs';
import type { EbayListing, EbayListingSummary } from '../core/src/ebay/types';
import type { JudgeRaw } from '../core/src/judge/types';

export interface RecordedPart { total: number; summaries: EbayListingSummary[]; items: Record<string, EbayListing> }

let loaded: Record<string, RecordedPart> | undefined;
/** The recording, by part model. */
export function recordedEbay(): Record<string, RecordedPart> {
  loaded ??= (JSON.parse(readFileSync(new URL('../fixtures/ebay/validation-2026-11-19.json', import.meta.url), 'utf8')) as { parts: Record<string, RecordedPart> }).parts;
  return loaded;
}

const legacyId = (itemId: string): string => itemId.split('|')[1] ?? itemId;

/** The Browse API's search answer for a list of listings: the fields core/src/ebay/parse reads, and nothing it drops. */
export function browseSearch(total: number, summaries: EbayListingSummary[]): unknown {
  return {
    total,
    itemSummaries: summaries.map((s) => ({
      itemId: s.itemId, title: s.title, price: { value: String(s.price ?? ''), currency: s.currency }, conditionId: s.conditionId ?? undefined,
      categoryIdPath: s.categoryIds.join('|'), legacyItemId: legacyId(s.itemId), ...(s.epid ? { epid: s.epid } : {}),
    })),
  };
}

/** The Browse API's getItem answer for a listing. */
export function browseItem(l: EbayListing): unknown {
  return {
    itemId: l.itemId, title: l.title, price: { value: String(l.price ?? ''), currency: l.currency }, conditionId: l.conditionId ?? undefined,
    categoryIdPath: l.categoryIds.join('|'), legacyItemId: legacyId(l.itemId), ...(l.epid ? { epid: l.epid } : {}),
    ...(l.brand ? { brand: l.brand } : {}), ...(l.mpn ? { mpn: l.mpn } : {}),
    localizedAspects: l.aspects.map((a) => ({ name: a.name, value: a.value })),
    description: l.descriptionText,
    estimatedAvailabilities: [{ ...(l.soldQuantity === null ? {} : { estimatedSoldQuantity: l.soldQuantity }) }],
    ...(l.revision ? { sellerItemRevision: l.revision } : {}),
  };
}

/** eBay's application token answer. */
export const ebayToken = (token = 'v^1.1#i^1#test-token', expiresIn = 7200): unknown => ({ access_token: token, expires_in: expiresIn, token_type: 'Application Access Token' });

/**
 * The listing a model's request is about, found by the title in its user message, among the recorded items.
 * The request carries no item id (and no price): the title is what the model reads.
 */
export function listingOfRequest(userMessage: string): EbayListing | undefined {
  const title = /<title>\n([\s\S]*?)\n<\/title>/.exec(userMessage)?.[1]?.trim();
  if (!title) return undefined;
  for (const part of Object.values(recordedEbay())) for (const item of Object.values(part.items)) if (item.title.trim() === title) return item;
  return undefined;
}

/**
 * What the canned model says, by item id. DCF921B (DEWALT's 1/2 in. impact wrench, 131 listings): five listings sold
 * New and exactly the tool are matches; one says the item specifics also name DCF911B, and the model is unsure of it.
 */
export const CANNED: Record<string, 'match' | 'unsure'> = {
  'v1|356061995376|0': 'match',
  'v1|137923389067|0': 'match',
  'v1|306552991202|0': 'match',
  'v1|407209694810|0': 'match',
  'v1|227617096880|0': 'match',
  'v1|920101779170|0': 'unsure',
};

export function cannedRaw(item: EbayListing): JudgeRaw {
  const said = CANNED[item.itemId];
  const identity = { claim: 'identity' as const, quote: item.title };
  if (said === 'match') {
    return {
      evidence: [identity, { claim: 'contents' as const, quote: item.title }], contentsMatch: true, quantity: 1, condition: 'new', extras: [], missing: [],
      reason: 'The title names the model and sells the tool.', verdict: 'match',
    };
  }
  if (said === 'unsure') {
    return {
      evidence: [identity], contentsMatch: null, quantity: 1, condition: 'new', extras: [], missing: [],
      reason: 'The title names the model, but the item specifics name a different model too.', verdict: 'unsure',
    };
  }
  return {
    evidence: [identity], contentsMatch: false, quantity: null, condition: null, extras: [], missing: [],
    reason: 'This listing is not that product.', verdict: 'not_match',
  };
}

/** A Messages API answer (what core's Claude adapter reads) carrying the canned verdict for the listing the request is about. */
export function anthropicAnswer(body: unknown): { status: number; body: unknown } {
  const messages = (body as { messages?: { content?: unknown }[] } | null)?.messages;
  const user = messages?.[0]?.content;
  const item = typeof user === 'string' ? listingOfRequest(user) : undefined;
  if (!item) return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'No recorded listing.' } } };
  return {
    status: 200,
    body: {
      id: 'msg_replay', type: 'message', role: 'assistant', model: 'replay', stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(cannedRaw(item)) }],
      usage: { input_tokens: 900, output_tokens: 150 },
    },
  };
}
