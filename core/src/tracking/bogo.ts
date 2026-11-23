// BOGO deals ("buy one, get one free", the PO: "for a BOGO deal, go through each item"). A promotion is the bundle
// plus N free items the owner chooses from the eligible list; its estimate is the bundle's way to sell plus the chosen
// free items' parts, at the same cost (the free item costs nothing). Until the owner chooses, the deal says
// "BOGO: choose your free tool" and the free tool is not counted. Nothing picks a free tool for him (rule 4).
//
// Since the Nov 23 BOGO recording the agent finds promotions by itself from Home Depot's pair listings (bogoPairs.ts);
// this owner's entry is the fallback for a promotion Home Depot lists no pairs for. SerpApi ignored the BOGO filter
// token, so bogoFacetOf is only a count of a search's BOGO items. See docs/decisions.md.

import { amazonNet, type BundleResult, type FeeSettings } from '../money';
import type { PartRow, SaleOption } from '../scan/types';

export interface FreeItem {
  brand: string;
  model: string;
  title: string | null;
  itemId: string | null;
  link: string | null;
  /** What the free item holds, when the owner says it is a kit; null: it is sold whole, as its own model. */
  parts: { model: string; qty: number }[] | null;
}

export interface BogoPromotion {
  bundleKey: string;
  /** Who said the bundle is on a BOGO promotion. Only the owner can, until a recording shows how Home Depot marks one. */
  source: 'owner';
  /** How many free items the promotion gives. */
  freeCount: number;
  /** The free items Home Depot offers with it, when the owner entered them; null when not known. */
  eligible: FreeItem[] | null;
  /** The owner's choice, at most freeCount items; empty until he chooses. */
  chosen: FreeItem[];
  /** The promotion's Home Depot page, when he gave it. */
  link: string | null;
  at: number;
}

export interface BogoCounted {
  model: string;
  /** The Amazon listing the price is from; null for a price the owner confirmed with no listing chosen. */
  asin: string | null;
  qty: number;
  price: number;
  /** After the referral fee and the flat fulfillment fee, times qty. */
  net: number;
}

export interface BogoView {
  status: 'choose' | 'chosen';
  /** "BOGO: choose your free tool", or "BOGO: DCF887B free". */
  label: string;
  freeCount: number;
  eligible: FreeItem[] | null;
  chosen: FreeItem[];
  link: string | null;
  /** The way to sell the estimate builds on (the primary). */
  optionId: string | null;
  /** That way to sell's estimate alone. */
  base: BundleResult | null;
  /** With the chosen free items' counted parts, at the same cost; equal to base while nothing free is counted. */
  estimate: BundleResult | null;
  counted: BogoCounted[];
  notCounted: { model: string; why: string }[];
  /** "+ free tool not counted yet", or which free parts are not counted and why; null when every free part counts. */
  note: string | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The free parts the chosen items stand for, by brand and model, quantities summed. */
export function freeParts(promo: BogoPromotion): { brand: string; model: string; qty: number }[] {
  const by = new Map<string, { brand: string; model: string; qty: number }>();
  for (const item of promo.chosen) {
    for (const p of item.parts ?? [{ model: item.model, qty: 1 }]) {
      const k = `${item.brand}:${p.model}`;
      const cur = by.get(k);
      if (cur) cur.qty += p.qty;
      else by.set(k, { brand: item.brand, model: p.model, qty: p.qty });
    }
  }
  return [...by.values()];
}

/** The part's counting price, as the report counts it: Amazon New while its listing is for sale, else a confirmed price. */
function countingPrice(p: PartRow): number | null {
  if (p.availability === 'active') {
    const featured = p.prices.find((o) => o.kind === 'amazon_new' && !o.reference);
    if (featured) return featured.price;
  }
  return p.prices.find((o) => o.kind === 'confirmed' && !o.reference)?.price ?? null;
}

function whyNot(p: PartRow): string {
  if (p.status === 'unmatched' || p.status === 'waiting') return 'not looked up on Amazon yet';
  if (p.status === 'review') return 'its Amazon match is in Review';
  if (p.status === 'none' || p.asin === null) return 'no Amazon listing';
  return 'no Amazon New price';
}

/**
 * The deal with its promotion. `option` is the bundle's primary way to sell; `parts` are the report's rows for
 * freeParts(promo) (report.ts partRowsFor), with the quantities freeParts gives.
 */
export function bogoView(promo: BogoPromotion, option: SaleOption | undefined, parts: PartRow[], fees: FeeSettings): BogoView {
  const base = option?.estimate ?? null;
  const chosen = promo.chosen.length > 0;
  const counted: BogoCounted[] = [];
  const notCounted: { model: string; why: string }[] = [];
  if (chosen) {
    for (const p of parts) {
      const price = countingPrice(p);
      if (price === null) notCounted.push({ model: p.model, why: whyNot(p) });
      else counted.push({ model: p.model, asin: p.asin, qty: p.qty, price, net: round2(amazonNet(price, fees) * p.qty) });
    }
  }
  let estimate: BundleResult | null = base;
  if (base && counted.length > 0) {
    const netRevenue = round2(base.netRevenue + counted.reduce((a, c) => a + c.net, 0));
    const profit = round2(netRevenue - base.cost);
    estimate = { cost: base.cost, netRevenue, profit, roi: base.cost ? Math.round((profit / base.cost) * 10_000) / 10_000 : 0 };
  }
  const free = promo.freeCount === 1 ? 'free tool' : 'free tools';
  let note: string | null = null;
  if (!chosen) note = `+ ${free} not counted yet`;
  else if (notCounted.length > 0) note = `+ ${notCounted.map((n) => `${n.model} not counted yet (${n.why})`).join('; ')}`;
  return {
    status: chosen ? 'chosen' : 'choose',
    label: chosen ? `BOGO: ${promo.chosen.map((c) => c.model).join(' + ')} free` : `BOGO: choose your ${free}`,
    freeCount: promo.freeCount,
    eligible: promo.eligible,
    chosen: promo.chosen,
    link: promo.link,
    optionId: option?.id ?? null,
    base,
    estimate,
    counted,
    notCounted,
    note,
  };
}

// ---------------------------------------------------------------- the owner's entry

export interface FreeItemInput {
  brand?: unknown;
  model?: unknown;
  title?: unknown;
  itemId?: unknown;
  link?: unknown;
  parts?: unknown;
}

const MODEL = /^[A-Z0-9][A-Z0-9-./]{0,39}$/;

function freeItemOf(v: unknown, bundleBrand: string): FreeItem | string {
  if (typeof v !== 'object' || v === null) return 'Each free item needs a model number.';
  const i = v as FreeItemInput;
  const model = typeof i.model === 'string' ? i.model.trim().toUpperCase() : '';
  if (!MODEL.test(model)) return 'Each free item needs a model number.';
  const brand = typeof i.brand === 'string' && i.brand.trim() ? i.brand.trim().toUpperCase() : bundleBrand;
  const link = typeof i.link === 'string' && /^https?:\/\//.test(i.link.trim()) ? i.link.trim() : null;
  const itemId = typeof i.itemId === 'string' && /^\d{6,12}$/.test(i.itemId.trim()) ? i.itemId.trim() : null;
  let parts: FreeItem['parts'] = null;
  if (i.parts !== undefined && i.parts !== null) {
    if (!Array.isArray(i.parts) || i.parts.length === 0 || i.parts.length > 8) return `List 1 to 8 parts for ${model}, or none to sell it whole.`;
    parts = [];
    for (const p of i.parts as unknown[]) {
      const pm = typeof (p as { model?: unknown })?.model === 'string' ? ((p as { model: string }).model.trim().toUpperCase()) : '';
      const qty = (p as { qty?: unknown })?.qty ?? 1;
      if (!MODEL.test(pm) || typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 10) return `Each part of ${model} needs a model number and a quantity from 1 to 10.`;
      parts.push({ model: pm, qty });
    }
  }
  const title = typeof i.title === 'string' && i.title.trim() ? i.title.trim().slice(0, 200) : null;
  return { brand, model, title, itemId, link, parts };
}

/**
 * The owner's POST /api/deals/:id/bogo body: `{ freeCount?, eligible?, chosen?, link? }`. Returns the promotion, or the
 * problem in one sentence. A chosen item must be on the eligible list when there is one; never more than freeCount.
 */
export function bogoFromBody(body: Record<string, unknown>, bundleKey: string, bundleBrand: string, prior: BogoPromotion | undefined, now: number): BogoPromotion | string {
  const freeCount = body.freeCount ?? prior?.freeCount ?? 1;
  if (typeof freeCount !== 'number' || !Number.isInteger(freeCount) || freeCount < 1 || freeCount > 5) return 'Use 1 to 5 free items.';
  const list = (v: unknown, what: string): FreeItem[] | string => {
    if (!Array.isArray(v) || v.length > 40) return `${what} must be a list of up to 40 items.`;
    const out: FreeItem[] = [];
    for (const x of v) {
      const item = freeItemOf(x, bundleBrand);
      if (typeof item === 'string') return item;
      out.push(item);
    }
    return out;
  };
  let eligible = prior?.eligible ?? null;
  if ('eligible' in body) {
    if (body.eligible === null) eligible = null;
    else {
      const e = list(body.eligible, 'eligible');
      if (typeof e === 'string') return e;
      eligible = e;
    }
  }
  let chosen = prior?.chosen ?? [];
  if ('chosen' in body) {
    const c = body.chosen === null ? [] : list(body.chosen, 'chosen');
    if (typeof c === 'string') return c;
    chosen = c;
  }
  if (chosen.length > freeCount) return `Choose at most ${freeCount} free ${freeCount === 1 ? 'item' : 'items'}.`;
  if (eligible) {
    const ok = new Set(eligible.map((e) => `${e.brand}:${e.model}`));
    const off = chosen.find((c) => !ok.has(`${c.brand}:${c.model}`));
    if (off) return `${off.model} is not on this promotion's eligible list.`;
  }
  let link = prior?.link ?? null;
  if ('link' in body) {
    if (body.link === null || body.link === '') link = null;
    else if (typeof body.link === 'string' && /^https?:\/\//.test(body.link.trim())) link = body.link.trim();
    else return 'The promotion link must start with http or https.';
  }
  return { bundleKey, source: 'owner', freeCount, eligible, chosen, link, at: now };
}

// ---------------------------------------------------------------- the one recorded shape

export interface BogoFacet {
  /** How many items the search's BOGO filter holds, as Home Depot counts them. */
  count: number | null;
  /** The hd_filter_tokens value that narrows the same search to them. */
  token: string;
  link: string | null;
}

/**
 * The "Featured BOGO" value of a SerpApi Home Depot search response's filters (recorded: hd-bundles-dewalt-p1.json
 * count "135", value "1z24hvk", under "The Home Depot Events"). It says the search has BOGO items, not which: the
 * rows themselves carry no promotion. Null when the response has none.
 */
export function bogoFacetOf(body: Record<string, unknown>): BogoFacet | null {
  const filters = Array.isArray(body.filters) ? body.filters : [];
  for (const f of filters) {
    const values = f && typeof f === 'object' && Array.isArray((f as { value?: unknown }).value) ? ((f as { value: unknown[] }).value) : [];
    for (const v of values) {
      if (!v || typeof v !== 'object') continue;
      const r = v as Record<string, unknown>;
      if (typeof r.name !== 'string' || r.name.trim().toLowerCase() !== 'featured bogo' || typeof r.value !== 'string' || !r.value) continue;
      const n = typeof r.count === 'string' ? Number(r.count) : typeof r.count === 'number' ? r.count : NaN;
      return { count: Number.isFinite(n) ? n : null, token: r.value, link: typeof r.link === 'string' ? r.link : null };
    }
  }
  return null;
}
