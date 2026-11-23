// The BOGO sheet's rules, apart from the screen (docs/decisions.md, "BOGO is the owner's entry"). A free tool is chosen
// only because he chose it: one of the items Home Depot offers when he entered the list, or a model he typed. This module
// turns his form into the body the agent takes (core/src/api/contract.ts BogoBody), checked as core checks it, or into
// the one sentence that says what is missing. Nothing picks a free tool for him (CLAUDE.md rule 4).

import type { BogoRequest, BogoView, FreeItem, FreeItemBody } from '../api/types';

/** core/src/tracking/bogo.ts MODEL: what a model number may look like. */
export const MODEL = /^[A-Z0-9][A-Z0-9-./]{0,39}$/;

export interface FreeToolForm {
  model: string;
  title: string;
  link: string;
}

export type BogoResult = { ok: true; body: BogoRequest } | { ok: false; problem: string };

/** A free tool he typed: a model number, and optionally its title and its Home Depot link. */
export function typedTool(form: FreeToolForm): BogoResult {
  const model = form.model.trim().toUpperCase();
  if (!MODEL.test(model)) return { ok: false, problem: 'Enter the free tool’s model number, such as DCF887B.' };
  const link = form.link.trim();
  if (link && !/^https?:\/\//i.test(link)) return { ok: false, problem: 'The link must start with http or https.' };
  const title = form.title.trim();
  const item: FreeItemBody = { model, ...(title ? { title } : {}), ...(link ? { link } : {}) };
  return { ok: true, body: { chosen: [item] } };
}

/** The free tools he ticked from the promotion's eligible list, in the list's order. */
export function pickedTools(eligible: readonly FreeItem[], picked: readonly string[], freeCount: number): BogoResult {
  const items = eligible.filter((e) => picked.includes(e.model));
  if (items.length === 0) return { ok: false, problem: freeCount === 1 ? 'Choose the free tool.' : `Choose up to ${freeCount} free tools.` };
  if (items.length > freeCount) return { ok: false, problem: `This promotion gives ${freeCount} free ${freeCount === 1 ? 'tool' : 'tools'}. Untick one.` };
  return {
    ok: true,
    body: {
      chosen: items.map((e): FreeItemBody => ({
        brand: e.brand,
        model: e.model,
        ...(e.title ? { title: e.title } : {}),
        ...(e.itemId ? { itemId: e.itemId } : {}),
        ...(e.link ? { link: e.link } : {}),
        ...(e.parts ? { parts: e.parts } : {}),
      })),
    },
  };
}

/** The deal menu's words for the promotion: Mark as BOGO…, Choose the free tool…, Change the free tool…. */
export function bogoMenuLabel(status: BogoView['status'] | null): string {
  return status === null ? 'Mark as BOGO…' : status === 'choose' ? 'Choose the free tool…' : 'Change the free tool…';
}
