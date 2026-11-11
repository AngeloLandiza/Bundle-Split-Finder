// The splitter's notes (core/src/decompose.ts, pageSplit.ts) and the match reasons (scan/runner.ts) are written
// for developers. The owner reads these sentences instead. The core notes are not changed: a review item's
// `reason` is its notes joined by "; ".

/** A piece of a sentence: words, or a model number (set in mono by the panel). */
export type ReasonPart = { text: string } | { model: string };

type Rule = [RegExp, (m: RegExpExecArray) => ReasonPart[]];

const words = (text: string): ReasonPart => ({ text });
/** "A, B" as models with their ", " kept between them. */
const models = (list: string): ReasonPart[] =>
  list.split(', ').flatMap((model, i): ReasonPart[] => (i === 0 ? [{ model }] : [words(', '), { model }]));
const plain = (text: string): Rule[1] => () => [words(text)];

const RULES: Rule[] = [
  [/^hyphen split, but a part is not in the catalog$/, plain('The model number names its parts, but not all of them are known products yet.')],
  [/^special-buy pattern, parts not in catalog$/, plain('The model number looks like a special buy, but its parts are not known products yet.')],
  [/^no known (?:RYOBI|DEWALT) bundle pattern$/, plain('The model number does not show what is inside.')],
  [/^'[^']*' fits (.+)$/, (m) => [words('Part of the model number fits more than one product: '), ...m[1]!.split(' and ').flatMap((x, i) => (i === 0 ? models(x) : [words(' or '), ...models(x)])), words('.')]],
  [/^'[^']*' can be split more than one way$/, plain('The model number can be read more than one way.')],
  [/^'[^']*' matches nothing in the catalog$/, plain('Part of the model number matches no known product.')],
  [/^model number says (.+)$/, (m) => [words('The model number says '), ...models(m[1]!), words('.')]],
  [/^page says (.+)$/, (m) => [words('The Home Depot page says '), ...models(m[1]!), words('.')]],
  [/^page names no models$/, plain('The Home Depot page names no parts.')],
  [
    /^page names (.+), which do not fit the model number$/,
    (m) => [words('The Home Depot page names '), ...models(m[1]!), words(`, which ${m[1]!.includes(', ') ? 'do' : 'does'} not fit the model number.`)],
  ],
  [/^page does not name (.+)$/, (m) => [words('The Home Depot page does not name '), ...models(m[1]!), words('.')]],
  [/^1 listing\(s\) show the model number, but the brand is not confirmed$/, plain('One listing shows this model number, but its brand is not confirmed.')],
  [/^(\d+) listing\(s\) show the model number, but the brand is not confirmed$/, (m) => [words(`${m[1]} listings show this model number, but their brand is not confirmed.`)]],
  [/^title says Replacement or OEM, which often marks a spare part$/, plain("The listing's title says Replacement or OEM, which often means a spare part.")],
];

/** A note may end with "(N more not shown)" when the owner was shown only the first few listings. */
const MORE_NOT_SHOWN = /^(.*?)\s*\((\d+) more not shown\)$/;

function sentence(note: string): ReasonPart[] {
  const more = MORE_NOT_SHOWN.exec(note);
  if (more) {
    const n = Number(more[2]);
    const tail = words(` ${n} more ${n === 1 ? 'listing is' : 'listings are'} not shown.`);
    return more[1] === '' ? [tail] : [...sentence(more[1]!), tail];
  }
  for (const [pattern, say] of RULES) {
    const m = pattern.exec(note);
    if (m) return say(m);
  }
  const text = note.trim();
  if (text === '') return [];
  return [words(`${text[0]!.toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`)];
}

/** A review item's reason, in plain sentences, with its model numbers set apart. */
export function reviewReasonParts(reason: string): ReasonPart[] {
  return reason
    .split('; ')
    .map(sentence)
    .filter((s) => s.length > 0)
    .flatMap((s, i): ReasonPart[] => (i === 0 ? s : [words(' '), ...s]));
}

/** The same sentences as one string. */
export function reviewReason(reason: string): string {
  return reviewReasonParts(reason)
    .map((p) => ('model' in p ? p.model : p.text))
    .join('');
}
