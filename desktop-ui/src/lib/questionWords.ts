// "Why it is asked" in plain words. The agent sends the technical notes the split code wrote, joined by "; "
// ("'DCS380B' matches nothing in the catalog; page names no models"). The owner is not meant to read those: each known
// note becomes one plain sentence, and the original stays available as a "Technical detail" line. A note this file does
// not know passes through unchanged: it is never guessed at (CLAUDE.md rule 4). Pure; Review and the deal inspector
// only draw it.

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
