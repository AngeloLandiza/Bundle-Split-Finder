// "Why it is asked" in plain words. The agent sends the technical notes the split code wrote, joined by "; "
// ("'DCS380B' matches nothing in the catalog; page names no models"). The owner is not meant to read those: each known
// note becomes one plain sentence, and the original stays available as a "Technical detail" line. A note this file does
// not know passes through unchanged: it is never guessed at (CLAUDE.md rule 4). Pure. Shared by the desktop UI (Review and the
// deal inspector draw it) and by the agent's rules brief (core/src/brief/rules.ts).

export interface QuestionContext {
  /** DEWALT or RYOBI, as the bundle carries it. */
  brand: string;
  /** The bundle's model number, as Home Depot shows it ("PCL1600K2-P553"). */
  model: string;
}

export interface PlainReason {
  /** The plain sentences, in the order of the notes, joined by a space. */
  text: string;
  /** The agent's own note when at least one sentence was reworded; null when nothing changed, so nothing to disclose. */
  technical: string | null;
}

/** "RYOBI tools" in a sentence; a bundle with no brand says "tools". */
const brandTools = (brand: string): string => (brand.trim() ? `${brand.trim()} tools` : 'tools');

/** The two items a hyphenated model number reads as ("PCL1600K2-P553"), or null when it does not have exactly two. */
function hyphenParts(model: string): [string, string] | null {
  const parts = model
    .split('-')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length === 2 ? [parts[0]!, parts[1]!] : null;
}

interface Rule {
  match: RegExp;
  say: (m: RegExpMatchArray, ctx: QuestionContext) => string;
}

const RULES: Rule[] = [
  {
    // 'DCS380B' matches nothing in the catalog
    match: /^'([^']+)' matches nothing in the catalog$/i,
    say: (m, ctx) => {
      const tail = m[1]!;
      const how = ctx.model.toUpperCase().endsWith(tail.toUpperCase()) ? 'ends in' : 'contains';
      return `The model number ${how} ${tail}, which is not on Amazon’s list of ${brandTools(ctx.brand)} yet.`;
    },
  },
  {
    // hyphen split, but a part is not in the catalog
    match: /^hyphen split, but a part is not in the catalog$/i,
    say: (_m, ctx) => {
      const two = hyphenParts(ctx.model);
      return `The model number reads as two items${two ? ` (${two[0]} + ${two[1]})` : ''}, but one of them is not on Amazon’s list of ${brandTools(ctx.brand)} yet.`;
    },
  },
  {
    // page names no models
    match: /^page names no models$/i,
    say: () => 'Home Depot’s page does not list the model numbers of what is inside.',
  },
  {
    // no known RYOBI bundle pattern
    match: /^no known (?:[A-Za-z]+ )?bundle pattern$/i,
    say: () => 'This model number does not follow a pattern Split Finder knows.',
  },
  // Nov 23, the third real scan (fixtures/e2e-2026-11-23/after-scan3/store/review.json): the notes of match questions and
  // of the split checks against Home Depot's own pages (core/src/scan/runner.ts, match.ts, settle.ts), word for word.
  {
    // 1 listing(s) show the model number, but the brand is not confirmed (DCF860B)
    match: /^(\d+) listing\(s\) show the model number, but the brand is not confirmed$/i,
    say: (m, ctx) => {
      const n = Number(m[1]);
      const brand = ctx.brand.trim() || 'the brand';
      return n === 1
        ? `One Amazon listing shows the model number, but it does not say it is ${brand}.`
        : `${n} Amazon listings show the model number, but none says it is ${brand}.`;
    },
  },
  {
    // 4 more listing(s) not shown
    match: /^(\d+) more listing\(s\) not shown$/i,
    say: (m) => (Number(m[1]) === 1 ? 'One more Amazon listing is not shown.' : `${m[1]} more Amazon listings are not shown.`),
  },
  {
    // model number in the title, brand not confirmed (match.ts BRAND_NOT_CONFIRMED)
    match: /^model number in the title, brand not confirmed$/i,
    say: (_m, ctx) => `The listing’s title has the model number, but it does not say it is ${ctx.brand.trim() || 'the brand'}.`,
  },
  {
    // title says Replacement or OEM, which often marks a spare part (DCH172B)
    match: /^title says Replacement or OEM, which often marks a spare part$/i,
    say: () => 'A listing’s title says Replacement or OEM, which often means a spare part, not the tool.',
  },
  {
    // title says kit, and a RYOBI model number does not say whether the part is itself a kit (A98401)
    match: /^title says kit, and a (?:[A-Za-z]+ )?model number does not say whether the part is itself a kit$/i,
    say: () => 'A listing’s title says kit, and the model number alone does not say whether this part is a kit.',
  },
  {
    // page names PBP003, which none of the parts explains (PCL1600K2-PBP2003)
    match: /^page names (\S+), which none of the parts explains$/i,
    say: (m) => `Home Depot’s page also names ${m[1]}, which is not one of the parts the model number gives.`,
  },
  {
    // Home Depot's search found no A986501 sold by itself (PCL1600K2-A986501)
    match: /^Home Depot['’]s search found no (\S+) sold by itself$/i,
    say: (m) => `Home Depot does not sell ${m[1]} on its own, so its page cannot confirm what is inside.`,
  },
];

/** One note in plain words, or null when this file does not know it. */
export function plainNote(note: string, ctx: QuestionContext): string | null {
  const n = note.trim();
  for (const rule of RULES) {
    const m = n.match(rule.match);
    if (m) return rule.say(m, ctx);
  }
  return null;
}

/** The whole reason, note by note. An unknown note stays as the agent wrote it, beside the ones that are reworded. */
export function plainReason(reason: string, ctx: QuestionContext): PlainReason {
  const notes = reason
    .split(';')
    .map((n) => n.trim())
    .filter(Boolean);
  if (notes.length === 0) return { text: reason.trim(), technical: null };
  let changed = false;
  const sentences = notes.map((n) => {
    const plain = plainNote(n, ctx);
    if (plain === null) return n;
    changed = true;
    return plain;
  });
  return { text: sentences.join(' '), technical: changed ? reason.trim() : null };
}
