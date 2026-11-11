// The splitter's notes (core/src/decompose.ts, pageSplit.ts) are written for developers. The owner reads these
// sentences instead. The core notes are not changed: a review item's `reason` is its notes joined by "; ".

type Rule = [RegExp, (m: RegExpExecArray) => string];

const RULES: Rule[] = [
  [/^hyphen split, but a part is not in the catalog$/, () => 'The model number names its parts, but not all of them are known products yet.'],
  [/^special-buy pattern, parts not in catalog$/, () => 'The model number looks like a special buy, but its parts are not known products yet.'],
  [/^no known (?:RYOBI|DEWALT) bundle pattern$/, () => 'The model number does not show what is inside.'],
  [/^'[^']*' fits (.+)$/, (m) => `Part of the model number fits more than one product: ${m[1]!.split(' and ').join(' or ')}.`],
  [/^'[^']*' can be split more than one way$/, () => 'The model number can be read more than one way.'],
  [/^'[^']*' matches nothing in the catalog$/, () => 'Part of the model number matches no known product.'],
  [/^model number says (.+)$/, (m) => `The model number says ${m[1]}.`],
  [/^page says (.+)$/, (m) => `The Home Depot page says ${m[1]}.`],
  [/^page names no models$/, () => 'The Home Depot page names no parts.'],
  [/^page names (.+), which do not fit the model number$/, (m) => `The Home Depot page names ${m[1]}, which does not fit the model number.`],
  [/^page does not name (.+)$/, (m) => `The Home Depot page does not name ${m[1]}.`],
];

function sentence(note: string): string {
  for (const [pattern, say] of RULES) {
    const m = pattern.exec(note);
    if (m) return say(m);
  }
  const text = note.trim();
  if (text === '') return '';
  return `${text[0]!.toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}`;
}

/** A review item's reason, in plain sentences. */
export function reviewReason(reason: string): string {
  return reason
    .split('; ')
    .map(sentence)
    .filter((s) => s !== '')
    .join(' ');
}
