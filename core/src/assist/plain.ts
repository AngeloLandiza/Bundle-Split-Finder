// Step 15, rule 5 (decision 5: "not verified" says why in plain words). The verifiers (assist/verify.ts,
// research/verify.ts) give technical reasons, kept on the suggestion and shown in Activity; the owner reads one sentence:
// "Not verified: the page never names DCK240C2. Check the Home Depot page." Every reason the verifiers write has a plain
// form here; one this file does not know reads as "the AI's answer did not pass the checks", never as a guess at it.

/** At most this many plain reasons in the sentence; the rest are in Activity. */
export const PLAIN_REASONS_MAX = 2;

type Rule = [RegExp, (m: RegExpExecArray) => string];

// In the order the owner most needs them: what is wrong with the parts, then the page, then the quotes.
const RULES: Rule[] = [
  [/^No quote from the bundle page's Includes, specification lines or description names (\S+)\.$/, (m) => `the page never names ${m[1]}`],
  [/^(\S+) is itself a bundle of (.+): its own Home Depot page lists them/, (m) => `${m[1]} is itself a bundle of ${m[2]}`],
  [/^(\S+) is a combo of (\d+) tools that the catalog does not know as a kit/, (m) => `${m[1]} is a ${m[2]}-tool combo, not a kit the app knows`],
  [/^(\S+) is not a model any source read gives/, (m) => `nothing the AI read shows ${m[1]} is a real model`],
  [/^(\S+) is the bundle itself, not one of its parts\.$/, (m) => `${m[1]} is the bundle itself`],
  [/^The bundle states (\d+) tools?; the parts hold (\d+)\.$/, (m) => `the bundle says ${m[1]} tool${m[1] === '1' ? '' : 's'}, and these parts make ${m[2]}`],
  [/^The bundle's own page states different tool counts \((.+)\)\.$/, (m) => `the page gives different tool counts (${m[1]})`],
  [/^The bundle's title counts (\d+) batter(?:y|ies); the parts hold (\d+)\.$/, (m) => `the title counts ${m[1]} batter${m[1] === '1' ? 'y' : 'ies'}, and these parts hold ${m[2]}`],
  [/^The bundle's title counts (\d+) batter(?:y|ies), and how many (\S+) holds cannot be read\.$/, (m) => `the title counts ${m[1]} batter${m[1] === '1' ? 'y' : 'ies'}, and how many ${m[2]} holds is unknown`],
  [/^The bundle's title names an? (.+) that no part is or holds\.$/, (m) => `the title names a ${m[1]}, and none of these parts is one`],
  [/^The bundle's title names a (\d+)-piece set that no part is\.$/, (m) => `the title names a ${m[1]}-piece set, and none of these parts is one`],
  [/^The bundle comes without a (battery|charger); (\S+) is or holds one\.$/, (m) => `the bundle comes without a ${m[1]}, and ${m[2]} has one`],
  [/^The bundle comes without a (battery|charger), and whether (\S+) holds one cannot be read from its names\.$/, (m) => `the bundle comes without a ${m[1]}, and whether ${m[2]} has one is unknown`],
  [/^What (\S+) is cannot be read from its names/, (m) => `what ${m[1]} is could not be told from its name`],
  [/^"(.+)" is model (\S+), not (\S+)\.$/, (m) => `the page names ${m[2]}, not ${m[3]}`],
  [/^(\S+) accounts for nothing on the bundle's Includes list\.$/, (m) => `nothing on the page's Includes list is ${m[1]}`],
  [/^"(.+)" on the bundle's Includes list is left over: no part accounts for it\.$/, (m) => `"${m[1]}" on the page belongs to none of these parts`],
  [/^"(.+)" is given to more than one part/, (m) => `"${m[1]}" is given to two parts`],
  [/^(\S+) is given quantity (\d+); the Includes items it accounts for count (\d+)\.$/, (m) => `the page lists ${m[3]} of ${m[1]}, the answer ${m[2]}`],
  [/^"(.+)" is (\d+) batter(?:y|ies); (\S+)'s own title and page say (.+)\.$/, (m) => `"${m[1]}" counts ${m[2]} batter${m[2] === '1' ? 'y' : 'ies'}, and ${m[3]} holds ${m[4]}`],
  [/^"(.+)" says (\d+) tools?; (\S+) holds (\d+)\.$/, (m) => `"${m[1]}" says ${m[2]} tools, and ${m[3]} holds ${m[4]}`],
  [/^"(.+)" is an? (.+), and no quote naming (\S+) says what it is\.$/, (m) => `nothing the AI quoted shows ${m[3]} is the ${m[2]} "${m[1]}"`],
  [/^Nothing on the bundle's own page shows (\S+) /, (m) => `nothing on the page shows ${m[1]} is in the bundle`],
  [/^The bundle's page has no Includes list and states no tool count/, () => 'the page has no list of what is in the box and no tool count'],
  [/^The bundle's page says "Motor Type: Brushed"; (\S+) is brushless\.$/, (m) => `the page says brushed, and ${m[1]} is brushless`],
  [/^(\S+) is listed twice/, (m) => `${m[1]} is given twice`],
  [/^No quote given for (\S+) names \1\.$/, (m) => `no quote the AI gave names ${m[1]}`],
  [/^The quote ".*" is not found in /, () => 'a quote the AI gave is not on the page it names'],
  [/^The quote ".*" spans two Includes lists/, () => 'a quote the AI gave runs across two lists on the page'],
  [/^The quote ".*" names a source that was not read/, () => 'a quote the AI gave names a page it did not read'],
  [/text written to an AI/, () => 'the page holds text written to an AI'],
  [/^No quote from listing (\S+) names (\S+)\.$/, (m) => `listing ${m[1]} never names ${m[2]}`],
  [/^Listing (\S+)'s title says "(.+)" before the model/, (m) => `listing ${m[1]} says "${m[2]}" before the model, as accessories do`],
  [/^Listing (\S+)'s title says "(.+)", which is not New\.$/, (m) => `listing ${m[1]} says "${m[2]}", not New`],
];

/** One technical reason in plain words, or null when this file does not know it. */
export function plainReason(reason: string): string | null {
  for (const [re, say] of RULES) {
    const m = re.exec(reason.trim());
    if (m) return say(m);
  }
  return null;
}

/** Which page the owner should check, by the question: a split's Home Depot page, a match's Amazon listing. */
const checkWhere = (kind: 'split' | 'match'): string => (kind === 'split' ? 'Check the Home Depot page.' : 'Check the Amazon listing.');

/**
 * The owner's one sentence for a suggestion the code did not verify: "Not verified: <at most two plain reasons>. Check
 * the Home Depot page." Each plain reason once, in the order the verifier gave them. Reasons with no plain form count as
 * one "the AI's answer did not pass the checks", said only when no known reason is.
 */
export function plainVerification(reasons: readonly string[], kind: 'split' | 'match' = 'split'): string {
  const plain: string[] = [];
  for (const r of reasons) {
    const p = plainReason(r);
    if (p !== null && !plain.includes(p)) plain.push(p);
  }
  const shown = plain.slice(0, PLAIN_REASONS_MAX);
  if (shown.length === 0) shown.push("the AI's answer did not pass the checks");
  const more = plain.length - shown.length;
  const tail = more > 0 ? `; ${more} more in Activity` : '';
  return `Not verified: ${shown.join('; ')}${tail}. ${checkWhere(kind)}`;
}
