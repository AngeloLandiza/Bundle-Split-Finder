// Answer once, apply everywhere (Nov 23): what the owner settled about one model, kept per brand and model, and applied to
// every current and future bundle that holds it, so he is not asked again.
//
//   isPart             "A986501 is in this box": he approved a reading that holds it, where Home Depot does not sell it on
//                      its own (or sells another model). Settles that part in every bundle whose model number spells it out
//                      (settle.ts rule 2), so "What is A986501 in this bundle?" is asked once.
//   sellAs             a special buy or a combo: sold whole (parts: null), or as the tools he entered in its place.
//   notSoldSeparately  "in the box, not sold separately": not counted (the liquidation rate, as an item with no model number)
//                      and no reason for an incomplete estimate (report.ts).
//
// What is already kept per brand and model is not copied here: a chosen Amazon listing is the part's match record (a user
// decision no scan changes, answers.ts) and a confirmed price is the part's confirmed price (confirmed.ts). Both already
// apply to every bundle that holds the part.
//
// A fact never overrides newer evidence that contradicts it: `staleness` says what changed, and the fact is then not applied
// until he keeps it (a new date) or changes it (forgotten). Rule 4: a fact is only what he said, about that model.

import type { UnsettledPart } from '../decompose';
import { choicesOf } from '../scan/answers';
import { dayOf } from '../scan/suggest';
import type { PartFactView, PartPriceRecord, PriceRecord, ReviewItem } from '../scan/types';
import { partKey } from '../scan/types';

/** When he said it, and where: the question and the bundle he answered it on, when it came from Review. */
export interface FactMark {
  at: number;
  questionId?: string;
  /** The model of the bundle he answered on ("PCL1600K2-A986501"). */
  bundle?: string;
}

export interface PartFact {
  /** partKey(brand, model) */
  key: string;
  brand: string;
  model: string;
  isPart?: FactMark;
  /** null parts: sold whole; else the tools sold in its place, one entry per unit. */
  sellAs?: FactMark & { parts: string[] | null };
  notSoldSeparately?: FactMark;
  updatedAt: number;
}

export type FactField = 'isPart' | 'sellAs' | 'notSoldSeparately';

const up = (s: string): string => s.trim().toUpperCase();

/** The fact with `field` set, merged into what he said before about the model. */
export function withFact(prev: PartFact | undefined, brand: string, model: string, field: FactField, mark: FactMark, parts?: string[] | null): PartFact {
  const base: PartFact = prev ?? { key: partKey(brand, model), brand: up(brand), model: up(model), updatedAt: mark.at };
  const value = field === 'sellAs' ? { ...mark, parts: parts ?? null } : { ...mark };
  return { ...base, [field]: value, updatedAt: mark.at };
}

/** The fact without `field`; null when nothing is left of it. */
export function withoutFact(prev: PartFact, field: FactField, now: number): PartFact | null {
  const { [field]: _gone, ...rest } = prev;
  const next = { ...rest, updatedAt: now } as PartFact;
  return next.isPart || next.sellAs || next.notSoldSeparately ? next : null;
}

// ---------------------------------------------------------------- from a Review answer

/** Removes one of each of `take` from `from` (a multiset difference), or null when `from` lacks one. */
function minus(from: readonly string[], take: readonly string[]): string[] | null {
  const left = [...from];
  for (const t of take) {
    const i = left.findIndex((x) => up(x) === up(t));
    if (i < 0) return null;
    left.splice(i, 1);
  }
  return left;
}

export interface RememberOutcome {
  facts: { field: FactField; brand: string; model: string; mark: FactMark; parts?: string[] | null }[];
  /** Models he asked to remember that this answer says nothing general about, with why, in one sentence each. */
  skipped: { model: string; why: string }[];
}

/**
 * What an answered split question lets the app remember for the models he ticked ("…and remember this for A986501"), each
 * only about what the question asked of it (its UnsettledPart):
 *   not sold on its own / another model sold: his parts hold it -> isPart; they leave it out -> nothing (leaving a part out
 *     of one bundle says nothing about another).
 *   special buy / combo: his parts hold it -> sellAs whole; they replace it, keeping every other part of the reading, with
 *     one or more tools -> sellAs those tools; anything else -> nothing.
 * An answer of None, or a model the question did not ask about, gives nothing.
 */
export function factsFromAnswer(item: ReviewItem, remember: readonly string[], now: number): RememberOutcome {
  const out: RememberOutcome = { facts: [], skipped: [] };
  const parts = item.kind === 'split' && item.answer !== null ? item.answerParts ?? null : null;
  const unsettled = new Map<string, UnsettledPart>((item.unsettledParts ?? []).map((u) => [up(u.model), u] as const));
  const reading = choicesOf(item)[0] ?? [];
  for (const raw of remember) {
    const model = up(raw);
    const u = unsettled.get(model);
    if (!u) {
      out.skipped.push({ model, why: `This question did not ask what ${model} is.` });
      continue;
    }
    if (parts === null) {
      out.skipped.push({ model, why: 'An answer of None says nothing about one part.' });
      continue;
    }
    const mark: FactMark = { at: now, questionId: item.id, bundle: item.model };
    const holds = parts.some((p) => up(p) === model);
    if (u.why === 'not_sold' || u.why === 'other_model') {
      if (holds) out.facts.push({ field: 'isPart', brand: item.brand, model, mark });
      else out.skipped.push({ model, why: `Your parts leave ${model} out of this bundle, which says nothing about other bundles.` });
      continue;
    }
    if (holds) {
      out.facts.push({ field: 'sellAs', brand: item.brand, model, mark, parts: null });
      continue;
    }
    const others = minus(reading, [model]);
    const tools = others === null ? null : minus(parts, others);
    if (tools && tools.length > 0) out.facts.push({ field: 'sellAs', brand: item.brand, model, mark, parts: tools.map(up) });
    else out.skipped.push({ model, why: `Your parts do not say what ${model} holds in place of it.` });
  }
  return out;
}

// ---------------------------------------------------------------- newer evidence

/**
 * Why a "not sold separately" fact no longer holds, or null: Home Depot's own reading found the part sold alone after he
 * said it, or its Amazon listing was seen for sale after he said it. One sentence, saying what changed and when.
 */
export function staleness(
  fact: PartFact, evidence: { hd?: PartPriceRecord; amazon?: Pick<PriceRecord, 'price' | 'seenAt' | 'checkedAt'> & { asin?: string } },
): string | null {
  const said = fact.notSoldSeparately;
  if (!said) return null;
  const hd = evidence.hd;
  if (hd && hd.price !== null && hd.seenAt !== null && hd.seenAt > said.at) {
    return `Home Depot sells ${fact.model} on its own since ${dayOf(hd.seenAt)} ($${hd.price.toFixed(2)}).`;
  }
  const a = evidence.amazon;
  if (a && a.price !== null && a.seenAt !== null && a.seenAt === a.checkedAt && a.seenAt > said.at) {
    return `Amazon lists ${fact.model} for sale since ${dayOf(a.seenAt)} ($${a.price.toFixed(2)}).`;
  }
  return null;
}

/** "In the box, not sold separately", "Sold whole", "Sold as PCL406B and PCL424B", "A part of the bundles that name it". */
function factText(f: PartFact): string {
  if (f.notSoldSeparately) return 'In the box, not sold separately';
  if (f.sellAs) return f.sellAs.parts === null ? 'Sold whole' : `Sold as ${f.sellAs.parts.join(' and ')}`;
  return 'A part of the bundles that name it';
}

/** The answer a part row shows: "not sold separately" first (it changes the count), then a sale as, then a part. */
const shown = (f: PartFact): FactField => (f.notSoldSeparately ? 'notSoldSeparately' : f.sellAs ? 'sellAs' : 'isPart');

/** What a part row shows of a fact: its words, which answer, when he said it and where, and what changed when it no longer holds. */
export function factView(f: PartFact, stale: string | null): PartFactView {
  const field = shown(f);
  const mark = f[field]!;
  return { text: factText(f), field, at: mark.at, ...(mark.questionId ? { questionId: mark.questionId } : {}), ...(stale ? { stale } : {}) };
}

/** "from your answer on Nov 23": the line a bundle shows beside a part a fact settled. */
export const fromAnswerLine = (at: number): string => `from your answer on ${dayOf(at)}`;
