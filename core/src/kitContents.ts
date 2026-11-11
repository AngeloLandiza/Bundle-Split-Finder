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
// Items are separated by commas (not a thousands comma), by a "(n)" that starts a new item with no
// comma before it ("... Ratchet (1) PBLRC25 ...", recorded on 328814689), and by " and " only before
// the manual: elsewhere "and" belongs to a name ("Reversible 1/4 in. and 3/8 in. Anvil", 327939252).
const ITEM_BREAK = /,(?!\d{3}\b)|\s+and\s+(?=operator[’']?s\s+manuals?\b)|\s+(?=\(\d+\)\s)/i;
// One item listing its own parts: "A13401 3/8 in. Deep well, thin wall socket - (1) 1/2 in., ..."
// (335849279). The text before " - " is the item; the "(n) ..." pieces after it are its parts.
const OWN_PARTS = /\s+-\s+(?=\(\d+\))/;
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
      const text = list.replace(INCLUDES, '');
      const own = OWN_PARTS.exec(text);
      const pieces = own ? [text.slice(0, own.index)] : text.split(ITEM_BREAK);
      for (const piece of pieces) {
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
// RYOBI writes a tool without its tool-only B (PBLRC25 for PBLRC25B). pageCatalog goes one way: a
// model X on the page also adds XB. Here the rule is two-way: one trailing B is removed from both
// models before they are compared, so X matches X and XB, XB matches XB and X, and XBB matches
// neither (it is compared as XB).
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
  let best: { readAt: number; itemId: string; items: KitItem[] } | null = null;
  for (const r of bundles) {
    if (norm(r.brand) !== b || !same(norm(r.model)) || !r.page) continue;
    const items = parseIncludes(b, r.page.bullets);
    if (!items.some((i) => i.model)) continue;
    // Newest reading first; on the same readAt the larger item id, so the record order never decides.
    const newer = !best || r.page.readAt > best.readAt
      || (r.page.readAt === best.readAt && r.itemId.localeCompare(best.itemId, 'en', { numeric: true }) > 0);
    if (newer) best = { readAt: r.page.readAt, itemId: r.itemId, items };
  }
  return best?.items ?? null;
}
