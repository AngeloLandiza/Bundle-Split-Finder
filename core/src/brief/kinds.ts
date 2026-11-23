// "What is it" words in a brief: a sentence that says a model number is a saw, a battery or a charger says something about the
// product, and it must not contradict the bundle's own title. The Haiku run (docs/decisions.md) had a check line "confirm P553 is
// the battery or charger" on a bundle titled "... Batteries, Charger, and Miter Saw": the title's last words name the last part.
//
// A closed vocabulary of tool and accessory words in families (a jig saw and a miter saw are both saws; a drill, a driver and an
// impact driver are one family, as the page words blur them), read on text the code holds. Nothing here decides an answer: a
// sentence that fails is dropped, which only costs the owner a less specific line.

/** Accessories come with a kit; everything else is a tool or a product of its own. */
const ACCESSORY: ReadonlySet<string> = new Set(['battery', 'charger']);

const FAMILIES: [string, RegExp][] = [
  ['saw', /\b(?:saw|saws|jigsaw|jig saw|miter|mitre|chainsaw)\b/i],
  ['drill', /\b(?:drill|drills|driver|drivers|drive|impact)\b/i],
  ['battery', /\b(?:battery|batteries)\b/i],
  ['charger', /\bchargers?\b/i],
  ['trimmer', /\b(?:trimmer|edger|string trimmer)\b/i],
  ['blower', /\b(?:blower|sweeper)\b/i],
  ['light', /\b(?:light|lights|flashlight|lantern|lamp)\b/i],
  ['sander', /\b(?:sander|sanding)\b/i],
  ['router', /\b(?:router|planer)\b/i],
  ['multi', /\b(?:multi[- ]?tool|oscillating)\b/i],
  ['cutter', /\b(?:cutter|shears|pruner|hedge)\b/i],
  ['fan', /\bfan\b/i],
  ['screwdriver', /\bscrewdriver\b/i],
  ['wrench', /\b(?:wrench|ratchet)\b/i],
  ['grinder', /\bgrinder\b/i],
  ['vacuum', /\b(?:vac|vacuum)\b/i],
  ['hammer', /\bhammer\b/i],
  ['clamp', /\bclamp\b/i],
];

/** The families of tool words a text names. */
export function familiesOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const [name, re] of FAMILIES) if (re.test(text)) out.add(name);
  return out;
}

/**
 * The last clause of a title: what follows its last "and", "w/", "with", "&" or comma. Home Depot writes a hyphenated bundle's
 * title in the order of its model ("KIT-EXTRA"), so these words name the last part.
 */
export function titleTail(title: string): string {
  const parts = title.split(/\s(?:and|w\/|with|&)\s|,\s*/i);
  return (parts[parts.length - 1] ?? '').trim().replace(/^(?:and|w\/|with|&)\s+/i, '');
}

/** What a text claims each model number is: the families named after the model, up to the next model number or the end of the sentence. */
export function claimsAbout(text: string, models: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const upper = text.toUpperCase();
  for (const model of models) {
    const m = model.toUpperCase();
    for (let at = upper.indexOf(m); at >= 0; at = upper.indexOf(m, at + 1)) {
      const rest = text.slice(at + m.length, at + m.length + 80).split(/[.;?!]|[A-Za-z]{1,5}\d[A-Za-z0-9-]*/)[0] ?? '';
      const fams = familiesOf(rest);
      if (fams.size === 0) continue;
      const have = out.get(model) ?? new Set<string>();
      fams.forEach((f) => have.add(f));
      out.set(model, have);
    }
  }
  return out;
}

/**
 * Why a text's "what it is" words are refused, or null. `lastModel` is the answer's last part (named by the title's last words);
 * `known` is every family the question and its quotes name (the title, the note, the readings, the quote cited).
 *  - a family named for a part that none of those names is invented;
 *  - the last part called an accessory (battery, charger) while the title's last words name a tool, or called a tool while the
 *    title's last words name another tool, contradicts the title.
 */
export function whyKindRefused(text: string, models: readonly string[], lastModel: string | null, title: string | null, known: ReadonlySet<string>): string | null {
  const claims = claimsAbout(text, models);
  for (const [model, fams] of claims) {
    const unknown = [...fams].filter((f) => !known.has(f));
    if (unknown.length > 0) return `It calls ${model} a ${unknown.join('/')}, which neither the title, the question nor the quote says.`;
  }
  if (lastModel === null || title === null) return null;
  const mine = claims.get(lastModel);
  if (!mine) return null;
  const tail = familiesOf(titleTail(title));
  if (tail.size === 0) return null;
  const tools = [...tail].filter((f) => !ACCESSORY.has(f));
  const claimsTool = [...mine].filter((f) => !ACCESSORY.has(f));
  // An accessory (battery, charger) is held to the title's last words whatever they name; a tool only when they name a tool: a
  // title that ends "Charger" does not say the last part is not a multi-tool, which the title may name earlier.
  const contradicts = claimsTool.length === 0 ? ![...mine].some((f) => tail.has(f)) : tools.length > 0 && !claimsTool.some((f) => tail.has(f));
  return contradicts ? `It calls ${lastModel} a ${[...mine].join('/')}, and the title's last words (“${titleTail(title)}”) name a ${[...tail].join('/')}.` : null;
}
