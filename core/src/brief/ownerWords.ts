// The verifier's plain sentences (assist/plain.ts) are written for the Activity log and the "Not verified: ..." line, and some
// still talk about the checker's own steps ("a quote the AI gave runs across two lists"). A brief is read by the owner on the
// card, so each such fragment gets a sentence about the page and the parts instead. A fragment this file does not reword is
// kept as it is (capitalised, with a full stop): never guessed at (CLAUDE.md rule 4).

type Rule = [RegExp, (m: RegExpExecArray) => string];

const item = (s: string): string => (s.length > 40 ? `${s.slice(0, 39).trimEnd()}…` : s);

const RULES: Rule[] = [
  // Items of the page's Includes list that no part accounts for.
  [/^"(.+)" on the page belongs to none of these parts$/, (m) => `The page also lists "${item(m[1]!)}", which none of these parts accounts for.`],
  [/^"(.+)" is given to two parts$/, (m) => `The page lists "${item(m[1]!)}" once, but two of the parts both claim it.`],
  [/^nothing the AI read shows (\S+) is a real model$/, (m) => `None of the pages the app read lists ${m[1]} as a model number.`],
  [/^what (\S+) is could not be told from its name$/, (m) => `The app cannot tell what ${m[1]} is from its name.`],
  [/^nothing on the page's Includes list is (\S+)$/, (m) => `Nothing on the page's Includes list matches ${m[1]}.`],
  [/^nothing the AI quoted shows (\S+) is the (.+) "(.+)"$/, (m) => `Nothing on the page shows that ${m[1]} is the ${m[2]} "${item(m[3]!)}".`],
  [/^no quote the AI gave names (\S+)$/, (m) => `No line on the page names ${m[1]}.`],
  // How the AI quoted the page: said as what the app could not do with it.
  [/^a quote the AI gave runs across two lists on the page$/, () => "The page's list mixes two items in one line, so the code could not match it."],
  [/^a quote the AI gave is not on the page it names$/, () => 'One line the AI relied on is not on the page, so the code could not check it.'],
  [/^a quote the AI gave names a page it did not read$/, () => 'The AI relied on a page the app did not read, so the code could not check it.'],
  [/^the page holds text written to an AI$/, () => 'The page holds text written to an AI, so it was not trusted.'],
];

/** One plain fragment (assist/plain.ts plainReason) as a sentence for the owner. */
export function ownerSentence(fragment: string): string {
  const f = fragment.trim();
  for (const [re, say] of RULES) {
    const m = re.exec(f);
    if (m) return say(m);
  }
  return `${f[0]!.toUpperCase()}${f.slice(1)}.`;
}
