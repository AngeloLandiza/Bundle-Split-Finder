// Rung 3 of the listing ladder (docs/decisions.md, "Confirming listings by themselves"): an AI listing judge for an Amazon
// listing the code could not confirm. Grounded, provider-neutral: the model reads the Home Depot part and the listing's
// stored fields and answers same / different / cannot tell, quoting the listing's own text for the model number and for
// anything that decides kit versus bare tool or pack size. Code then checks every quote word for word against the field
// it names and applies the same contradictions as rung 1 (keepa/listingFields.ts). Only a "same" whose quotes all check
// out, with a model-number quote naming the part's model and nothing contradicting, becomes `verifiedBy: 'ai_checked'`.
//
// Shipped off (ai.listingJudge.enabled false): a buy never rests on 'ai_checked' (tracking/signals.ts CONFIRMING_SOURCES)
// until scripts/listing-judge-eval.ts measures it at zero wrong on the recorded rows.

import { answerFrom } from '../ai/answer';
import type { ModelProvider } from '../ai/types';
import type { TokenUsage } from '../judge/types';
import { makerAgrees, makerWords } from '../keepa/brandAliases';
import { listingProblem } from '../keepa/listingFields';
import type { ListingIdentity } from '../keepa/verify';
import { MODEL_PATTERNS, sameModel, type Wanted } from '../match';
import { cleanBrand } from '../serpapi/parsers';

export const LISTING_JUDGE_PROMPT_VERSION = 'listing-judge-1';
export const LISTING_JUDGE_MAX_TOKENS = 1500;

export type PartKind = 'bare tool' | 'kit' | 'battery' | 'charger' | 'accessory' | 'unknown';

export interface ListingJudgePart {
  brand: string;
  model: string;
  /** Home Depot's title for the part, when stored. */
  title?: string;
  kind: PartKind;
  /** How many units the part is (DEWALT's -2 packs); 1 otherwise. */
  packQty: number;
}

/** The listing fields a quote may name. */
export const QUOTE_FIELDS = ['title', 'brand', 'manufacturer', 'model', 'part_number', 'feature'] as const;
export type QuoteField = (typeof QUOTE_FIELDS)[number];
export const QUOTE_ABOUT = ['model_number', 'kit_or_bare', 'pack_size', 'brand'] as const;

export interface ListingQuote {
  about: (typeof QUOTE_ABOUT)[number];
  field: QuoteField;
  quote: string;
}

export interface ListingJudgeRaw {
  quotes: ListingQuote[];
  reason: string;
  verdict: 'same' | 'different' | 'cannot_tell';
}

export const LISTING_JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    quotes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          about: { type: 'string', enum: [...QUOTE_ABOUT] },
          field: { type: 'string', enum: [...QUOTE_FIELDS] },
          quote: { type: 'string' },
        },
        required: ['about', 'field', 'quote'],
        additionalProperties: false,
      },
    },
    reason: { type: 'string' },
    verdict: { type: 'string', enum: ['same', 'different', 'cannot_tell'] },
  },
  required: ['quotes', 'reason', 'verdict'],
  additionalProperties: false,
} as const;

export const LISTING_JUDGE_PROMPT = `You decide whether an Amazon listing sells exactly one Home Depot part: the same product, the same kit contents, the same pack size.

Answer "same" only when the listing's own text proves it. Answer "different" when the listing's text shows another product, another model, a kit where the part is a bare tool (or the reverse), a different pack size or battery size, a used or renewed item, or a part made "for" or "compatible with" the brand. Answer "cannot_tell" whenever you are not certain. A wrong "same" costs the seller money; "cannot_tell" costs nothing.

Quote the listing word for word, copying the exact characters from one field (title, brand, manufacturer, model, part_number or feature). Give:
- one quote about the model_number: the text where the listing names the part's model number;
- a quote about kit_or_bare when the listing says tool only, bare tool, kit, battery or charger included or not included;
- a quote about pack_size when the listing names a pack, a count or a set;
- a quote about the brand when the brand field is empty and the title names the brand.
Never quote the Home Depot part. Never paraphrase. Then give a one-sentence reason and the verdict.`;

/** A listing's fields for the judge: what the catalog pull or page stored. */
export function renderListingJudgeInput(part: ListingJudgePart, l: ListingIdentity): string {
  const line = (k: string, v: string | number | null | undefined) => `${k}: ${v === null || v === undefined || v === '' ? '(none)' : v}`;
  return [
    'Home Depot part',
    line('brand', part.brand),
    line('model', part.model),
    line('title', part.title),
    line('what it is', part.kind),
    line('pack size', part.packQty),
    '',
    'Amazon listing',
    line('title', l.title),
    line('brand', l.brand),
    line('manufacturer', l.manufacturer),
    line('model', l.model),
    line('part_number', l.partNumber),
    line('package quantity', l.packageQuantity),
    line('number of items', l.numberOfItems),
    ...(l.features && l.features.length > 0 ? ['features:', ...l.features.map((f) => `- ${f}`)] : [line('features', null)]),
  ].join('\n');
}

const QUOTE_LIMIT = 20;

/** Reads a model answer against the schema without trusting the provider to have checked it. */
export function parseListingJudge(text: string): { ok: true; raw: ListingJudgeRaw } | { ok: false; problem: string } {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return { ok: false, problem: 'The answer is not JSON.' }; }
  const o = j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
  if (!o || !Array.isArray(o.quotes) || typeof o.reason !== 'string' || !['same', 'different', 'cannot_tell'].includes(o.verdict as string)) {
    return { ok: false, problem: 'The answer does not have quotes, a reason and a verdict.' };
  }
  const quotes: ListingQuote[] = [];
  for (const q of o.quotes.slice(0, QUOTE_LIMIT)) {
    const r = q && typeof q === 'object' ? (q as Record<string, unknown>) : {};
    if (!QUOTE_ABOUT.includes(r.about as never) || !QUOTE_FIELDS.includes(r.field as never) || typeof r.quote !== 'string') return { ok: false, problem: 'A quote is malformed.' };
    quotes.push({ about: r.about as ListingQuote['about'], field: r.field as QuoteField, quote: r.quote });
  }
  return { ok: true, raw: { quotes, reason: o.reason, verdict: o.verdict as ListingJudgeRaw['verdict'] } };
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

function fieldTexts(l: ListingIdentity, field: QuoteField): string[] {
  switch (field) {
    case 'title': return l.title ? [l.title] : [];
    case 'brand': return l.brand ? [l.brand] : [];
    case 'manufacturer': return l.manufacturer ? [l.manufacturer] : [];
    case 'model': return l.model ? [l.model] : [];
    case 'part_number': return l.partNumber ? [l.partNumber] : [];
    case 'feature': return l.features ?? [];
  }
}

/** Whether the quote stands word for word in the field it names (spaces and letter case aside). */
export function quoteFound(l: ListingIdentity, q: ListingQuote): boolean {
  const want = squash(q.quote);
  return want.length >= 2 && fieldTexts(l, q.field).some((t) => squash(t).includes(want));
}

const brandKey = (raw: string | null | undefined): string | null => {
  const b = cleanBrand(raw ?? null);
  const k = b ? b.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  return k === '' ? null : k;
};

/** Whether a quote names the part's model as a whole token, and no other model of the brand. */
function namesModel(brand: string, model: string, quote: string): boolean {
  const pattern = MODEL_PATTERNS[brand];
  const tokens = pattern
    ? Array.from(quote.toUpperCase().matchAll(new RegExp(pattern.source, 'g')), (m) => m[0])
    : quote.toUpperCase().split(/[^A-Z0-9-]+/).filter((t) => t !== '');
  const hits = tokens.filter((t) => sameModel(brand, t, model));
  return hits.length > 0 && (!pattern || tokens.every((t) => sameModel(brand, t, model)));
}

export type ListingJudgeOutcome =
  | { status: 'ai_checked'; reason: string; checks: string[] }
  | { status: 'different' | 'cannot_tell'; reason: string; checks: string[] };

/**
 * The code's check of a judge's answer. "same" becomes ai_checked only when every quote is found word for word, a
 * model-number quote names the part's model and no other, the brand is the part's (the brand field, or with no brand
 * field a found brand quote and no other maker), and rung 1's contradictions find nothing. Anything short of that is
 * cannot_tell; a "different" stays different (shown, never acted on).
 */
export function checkListingJudge(want: Wanted, l: ListingIdentity, raw: ListingJudgeRaw, opts: { makers?: boolean } = {}): ListingJudgeOutcome {
  const brand = want.brand.trim().toUpperCase();
  const model = want.model.trim().toUpperCase();
  const checks: string[] = [];
  if (raw.verdict !== 'same') return { status: raw.verdict, reason: raw.reason, checks };
  const missing = raw.quotes.filter((q) => !quoteFound(l, q));
  if (missing.length > 0) return { status: 'cannot_tell', reason: `a quote is not on the listing: "${missing[0]!.quote}"`, checks };
  checks.push('every quote was found word for word on the listing');
  const modelQuote = raw.quotes.find((q) => q.about === 'model_number' && namesModel(brand, model, q.quote));
  if (!modelQuote) return { status: 'cannot_tell', reason: `no quote names ${model}`, checks };
  checks.push(`the quote names ${model}`);
  const listed = brandKey(l.brand);
  const maker = brandKey(l.manufacturer);
  // With no brand field, only a title that begins with the brand names it (as the matcher's brand prefix): "… Screw for New
  // Ryobi P553" (B0HN1FZ74T, a spare part) does not.
  const brandQuoted = raw.quotes.some((q) => q.about === 'brand' && squash(q.quote).toUpperCase().includes(brand))
    && (l.title ?? '').trim().toUpperCase().startsWith(brand);
  if (listed !== null && listed !== brand) return { status: 'cannot_tell', reason: `the brand field is ${cleanBrand(l.brand)}`, checks };
  // The manufacturer rule of rungs 0 and 1 (brandAliases.ts makerAgrees): the brand, a recorded maker of it, or its name plus "Tools".
  if (maker !== null && !makerAgrees(brand, l.manufacturer, opts)) return { status: 'cannot_tell', reason: `the manufacturer is ${l.manufacturer}`, checks };
  if (listed === null && !brandQuoted) return { status: 'cannot_tell', reason: 'the listing names no brand', checks };
  checks.push(listed !== null ? `the brand field is ${brand}` : `the listing's title begins with ${brand}`);
  const made = opts.makers === false ? null : makerWords(brand, l.manufacturer);
  if (made) checks.push(`the ${made}`);
  // Stricter than rung 1: a title that names any other model of the brand is not this part for an AI's say-so.
  const pattern = MODEL_PATTERNS[brand];
  const others = pattern ? Array.from((l.title ?? '').toUpperCase().matchAll(new RegExp(pattern.source, 'g')), (m) => m[0]).filter((m) => !sameModel(brand, m, model)) : [];
  if (others.length > 0) return { status: 'cannot_tell', reason: `the title also names ${others[0]}`, checks };
  const problem = listingProblem(want, { ...l, brand: l.brand ?? brand }, opts);
  if (problem) return { status: 'cannot_tell', reason: problem, checks };
  checks.push('nothing on the listing contradicts it (pack, kit, battery, replacement)');
  return { status: 'ai_checked', reason: raw.reason, checks };
}

/** What one call gave: the outcome after the code's check, or why there is none. */
export type ListingJudgeCall =
  | { ok: true; raw: ListingJudgeRaw; outcome: ListingJudgeOutcome; usage: TokenUsage }
  | { ok: false; problem: string; usage?: TokenUsage };

/** One call to any provider; the answer read through the neutral layer and checked by code. */
export async function judgeListingWith(
  provider: ModelProvider, part: ListingJudgePart, want: Wanted, l: ListingIdentity, signal?: AbortSignal,
): Promise<ListingJudgeCall> {
  const res = await provider.send({
    system: LISTING_JUDGE_PROMPT,
    messages: [{ role: 'user', content: renderListingJudgeInput(part, l) }],
    responseSchema: LISTING_JUDGE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: LISTING_JUDGE_MAX_TOKENS,
    effort: 'low',
  }, signal);
  const a = answerFrom(res, provider.label, `${provider.label} declined to judge this listing.`);
  if (!a.ok) return { ok: false, problem: a.notJudged.message, ...(a.usage ? { usage: a.usage } : {}) };
  const parsed = parseListingJudge(a.answer);
  if (!parsed.ok) return { ok: false, problem: parsed.problem, usage: a.usage };
  return { ok: true, raw: parsed.raw, outcome: checkListingJudge(want, l, parsed.raw), usage: a.usage };
}

/** What the part is, for the judge: from the model's own shape and the catalog's kit flag. Never a guess beyond those. */
export function partKind(want: Wanted): PartKind {
  const m = want.model.toUpperCase();
  if (want.isKit) return 'kit';
  if (/^(PCG\d|DCB1[01]\d$)/.test(m)) return 'charger';
  if (/^(PBP\d|DCB[2-6]\d\d)/.test(m)) return 'battery';
  if (want.brand.toUpperCase() === 'RYOBI' && m.endsWith('B')) return 'bare tool';
  if (want.brand.toUpperCase() === 'DEWALT' && /^DC[A-Z]{1,3}\d{3,4}B$/.test(m)) return 'bare tool';
  return 'unknown';
}
