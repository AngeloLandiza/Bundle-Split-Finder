// A kit's contents, read from the "Includes:" bullets of the kit's own Home Depot page.
//
// pageCatalog (pageSplit.ts) reads the same bullets for model numbers only. Here every boxed item
// is kept, with its quantity: an item with no model number ("18V Charger", "Tool Bag") is an
// unnamed item, and only paperwork (the operator's manual) is dropped. A kit's contents come only
// from a stored record of that kit's own brand and model, never from another bundle's page.

import { OFFERABLE_PART } from './decompose';
import { DEWALT_LEADING, RYOBI_TOKEN } from './pageSplit';
import type { BundleRecord } from './scan/types';

export interface KitItem {
  /** The item's model number, or null for an item the page names without one. */
  model: string | null;
  /** The item's text without its "(n)": for a model item, the model and its description. */
  name: string;
  qty: number;
}

// "Includes:" with its colon. "Includes hex shank drill bits ..." (no colon) is a feature line.
const INCLUDES = /^\s*includes\s*:/i;
// Two lists in one bullet: "... and Operator's Manual : Includes: (1) PBP004 ...".
const NEXT_LIST = /\s:\s*includes\s*:/i;
// Items are separated by commas (not a thousands comma), by " and ", and by a "(n)" that starts a
// new item with no comma before it ("... Ratchet (1) PBLRC25 ...", recorded on 328814689).
const ITEM_BREAK = /,(?!\d{3}\b)|\s+and\s+|\s+(?=\(\d+\)\s)/i;
const QTY = /^\((\d+)\)\s*/;
const PAPERWORK = /^operator[’']?s\s+manuals?$/i;

/** Whether a word is a whole model number of the brand that could be offered as a part. */
function isModel(brand: string, word: string): boolean {
  if (!OFFERABLE_PART.test(word)) return false;
  if (brand === 'RYOBI') return word.match(RYOBI_TOKEN)?.[0] === word;
  // The DEWALT shape is the one that leads a DEWALT bullet ("DCF921B: ..."), here as a whole word.
  if (brand === 'DEWALT') return DEWALT_LEADING.exec(`${word}:`)?.[1] === word;
  return false;
}

/** The items a page's Includes bullets name, in page order. [] when no bullet is an Includes list. */
export function parseIncludes(brand: string, bullets: string[]): KitItem[] {
  const b = brand.toUpperCase().trim();
  const items: KitItem[] = [];
  for (const bullet of bullets) {
    if (!INCLUDES.test(bullet)) continue;
    for (const list of bullet.split(NEXT_LIST)) {
      for (const piece of list.replace(INCLUDES, '').split(ITEM_BREAK)) {
        let text = piece.trim().replace(/^and\s+/i, '');
        const qty = QTY.exec(text);
        if (qty) text = text.slice(qty[0].length).trim();
        if (!text || PAPERWORK.test(text)) continue;
        const word = text.split(/\s+/)[0] ?? '';
        items.push({ model: isModel(b, word) ? word : null, name: text, qty: qty ? Number(qty[1]) : 1 });
      }
    }
  }
  return items;
}

const norm = (s: string): string => s.toUpperCase().trim();
// RYOBI writes a tool without its tool-only B (PBLRC25 for PBLRC25B), as pageCatalog allows.
const ryobiBase = (m: string): string => (m.endsWith('B') ? m.slice(0, -1) : m);

/**
 * A kit's items from its own stored page: the newest reading, among the stored records of this
 * brand and model, whose Includes list names at least one model. Null when there is none. A bundle
 * that holds the kit has another model (PCL1600K2-PBP004), so its page is never read here.
 */
export function kitContents(bundles: BundleRecord[], brand: string, model: string): KitItem[] | null {
  const b = norm(brand);
  const m = norm(model);
  const same = (other: string): boolean =>
    other === m || (b === 'RYOBI' && ryobiBase(other) === ryobiBase(m));
  let best: { readAt: number; items: KitItem[] } | null = null;
  for (const r of bundles) {
    if (norm(r.brand) !== b || !same(norm(r.model)) || !r.page) continue;
    const items = parseIncludes(b, r.page.bullets);
    if (!items.some((i) => i.model)) continue;
    if (!best || r.page.readAt > best.readAt) best = { readAt: r.page.readAt, items };
  }
  return best?.items ?? null;
}
