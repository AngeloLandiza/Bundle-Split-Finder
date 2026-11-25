// The brief the app shows for one open question (GET /api/review): the one a model wrote for the live suggestion and the
// code checked, when there is one; otherwise the rules' own. Pure: it reads only what the question and its suggestion hold.
// Step 16: a check the app's own tools can do (who.ts) is never shown as an instruction: cardCheck puts in its place what
// the app is doing about it or already did (the question's follow-up loop).

import type { StoredSuggestion } from '../assist/stored';
import type { PageConflict, SettledPart, UnsettledPart } from '../decompose';
import type { ReviewFollowUp } from '../research/followUp';
import type { EbayQuestion, ReviewItem } from '../scan/types';
import { briefInputOf, poolOfLines, type BriefSourceLink } from './input';
import { cutText, MAX_CHECK_CHARS, MAX_REASON_CHARS, rulesBrief } from './rules';
import type { BriefCheck, BriefReason, BriefState, ReviewBrief } from './types';
import { checkWho } from './who';

/**
 * The check line as the card shows it. An owner's check stays as written. An app's check (a page read, an Includes read, a
 * model or listing lookup) becomes a sentence about the app's own work: what it is doing while its follow-up runs, what it
 * read once it ran, or what it did to check a verified answer. Its link stays, so the page is one click away. A brief kept
 * before step 16 has no `who`: it is decided here by the same rule.
 */
export function cardCheck(check: BriefCheck | (Omit<BriefCheck, 'who'> & { who?: BriefCheck['who'] }) | null, kind: 'split' | 'match', state: BriefState, followUp?: ReviewFollowUp): BriefCheck | null {
  if (!check) return null;
  const who = check.who ?? checkWho(check.text, kind);
  const link = { ...(check.url ? { url: check.url } : {}), ...(check.linkLabel ? { linkLabel: check.linkLabel } : {}) };
  if (who === 'owner') return { ...check, who };
  let text: string;
  if (followUp && (followUp.state === 'queued' || followUp.state === 'running')) {
    text = followUp.doing ? `${followUp.doing}.` : 'The app is reading the pages this needs.';
  } else if (followUp && followUp.tried.length === 0) {
    // The loop ran and found nothing it could read: what is left is a person's call, so the check is the owner's.
    return { text: 'The app has nothing more it can read for this; the answer is your call.', who: 'owner', ...link };
  } else if (followUp && followUp.tried.length > 0) {
    const n = followUp.tried.length;
    text = state === 'verified'
      ? `The app read what this needed (${n} ${n === 1 ? 'step' : 'steps'}), and the answer passed its checks.`
      : `The app already read what it could for this (${n} ${n === 1 ? 'step' : 'steps'}); what it found is listed with this question, and the answer is your call.`;
  } else if (state === 'verified') {
    text = kind === 'split'
      ? "The app read the bundle's Home Depot page and found each part on it."
      : 'The app read the Amazon listing and found the part on it.';
  } else {
    text = kind === 'split'
      ? 'The app reads the Home Depot pages this needs when Chrome is open.'
      : "The app checks Amazon's catalog record for these listings.";
  }
  return { text: cutText(text, MAX_CHECK_CHARS), who: 'app', ...link };
}

const listOf = (ms: readonly string[]): string => (ms.length <= 1 ? ms[0] ?? '' : `${ms.slice(0, -1).join(', ')} and ${ms[ms.length - 1]}`);

/** What a part's Home Depot reading says, as a clause of the owner's check. */
function clauseOf(p: UnsettledPart): string {
  switch (p.why) {
    case 'not_sold': return `Home Depot does not sell ${p.model} on its own`;
    case 'other_model': return `Home Depot sells ${p.other ?? 'another model'}, not ${p.model}`;
    case 'special_buy': return `Home Depot sells ${p.model} as a special buy, itself a set of tools`;
    case 'combo': return `Home Depot sells ${p.model} as a combo of tools`;
  }
}

/** The same, short, for a check naming several parts. */
function shortClauseOf(p: UnsettledPart): string {
  switch (p.why) {
    case 'not_sold': return `${p.model} is not sold on its own`;
    case 'other_model': return `${p.other ?? 'another model'} is sold, not ${p.model}`;
    case 'special_buy': return `${p.model} is a special buy`;
    case 'combo': return `${p.model} is a combo of tools`;
  }
}

/**
 * Step 16 (round 2): the owner's check of a question narrowed to the parts Home Depot did not confirm: only a person can say
 * these (whether a part not sold on its own is in the box and worth selling, whether a special buy is kept whole), so it is
 * `owner`. One part: its own sentence. Several: each clause, then what to do. The PO's rule keeps every part with a model
 * number a part (decisions: everything counts, except manuals), so a part not sold on its own is approved as a part and its
 * sale is the owner's call on the part, after (mark it not sold separately).
 */
export function narrowCheck(unsettled: readonly UnsettledPart[], total: number, link?: { url: string; linkLabel: string }): BriefCheck {
  const one = unsettled.length === 1 ? unsettled[0]! : null;
  let text: string;
  if (one?.why === 'not_sold') text = `${clauseOf(one)}. If it is in this box, approve the ${total} parts; you can mark ${one.model} not sold separately after.`;
  else if (one?.why === 'special_buy' || one?.why === 'combo') text = `${clauseOf(one)}. Keep it as one part, or enter the tools inside it?`;
  else if (one) text = `${clauseOf(one)}. Which one is in this box?`;
  else text = `Home Depot: ${unsettled.map(shortClauseOf).join('; ')}. Approve the parts as listed, or enter them?`;
  const url = unsettled.find((p) => p.url)?.url;
  return { text: cutText(text, MAX_CHECK_CHARS), who: 'owner', ...(url ? { url, linkLabel: 'Home Depot page' } : link ? link : {}) };
}

/**
 * Nov 25: the brief of a split question on two Home Depot pages that disagree on the kit (PageConflict): what each page
 * names, with each page linked, and the owner's one decision. Nothing in it is a guess: both sides are quoted, neither is
 * preferred, and the reading the model number gives is what approving takes.
 */
export function conflictBrief(c: PageConflict, brief: ReviewBrief): ReviewBrief {
  const reasons: BriefReason[] = [
    {
      text: cutText(`This bundle's Home Depot page names ${listOf(c.bundleNames)}, which ${c.kit}'s own page does not.`, MAX_REASON_CHARS),
      ...(c.bundleQuote ? { quote: cutText(c.bundleQuote, 160) } : {}), sourceLabel: 'Home Depot bundle page', ...(c.bundleUrl ? { url: c.bundleUrl } : {}),
    },
    {
      text: cutText(`${c.kit}'s own Home Depot page names ${listOf(c.kitNames)}.`, MAX_REASON_CHARS),
      ...(c.kitQuote ? { quote: cutText(c.kitQuote, 160) } : {}), sourceLabel: `Home Depot page of ${c.kit}`, ...(c.kitUrl ? { url: c.kitUrl } : {}),
    },
  ];
  const text = `Home Depot's two pages disagree. If the box holds ${c.kit}, approve ${c.kit} and ${c.tool}; if it holds ${listOf(c.bundleNames)}, enter the parts.`;
  return {
    ...brief,
    ask: `Is ${c.kit} in this box, as the model number says, or ${listOf(c.bundleNames)}?`,
    reasons,
    check: { text: cutText(text, MAX_CHECK_CHARS), who: 'owner', ...(c.bundleUrl ? { url: c.bundleUrl, linkLabel: 'Home Depot bundle page' } : {}) },
  };
}

/** The brief of a split or match question. `live` is the suggestion made for the question as it is now, or null. */
export function briefForQuestion(
  question: ReviewItem,
  live: StoredSuggestion | null,
  evidence: readonly { text: string; source: { label: string; url: string | null } }[],
  sources: readonly BriefSourceLink[],
  followUp?: ReviewFollowUp,
  narrow?: { settled: readonly SettledPart[]; unsettled: readonly UnsettledPart[] },
): ReviewBrief {
  const brief = live?.brief ?? rulesBrief(briefInputOf(question, live?.suggestion ?? null, poolOfLines(evidence), sources));
  if (question.kind === 'split' && question.conflict && brief.state !== 'verified') return conflictBrief(question.conflict, brief);
  if (question.kind === 'split' && narrow && narrow.unsettled.length > 0 && brief.state !== 'verified') {
    // Step 16 (round 2): the question names only the parts Home Depot did not confirm; the confirmed ones are a reason, with a page.
    const models = narrow.unsettled.map((p) => p.model);
    const total = narrow.settled.length + narrow.unsettled.length;
    const first = narrow.settled[0];
    const settledReason = first
      ? [{ text: cutText(`Home Depot sells ${listOf(narrow.settled.map((p) => p.model))} on ${narrow.settled.length === 1 ? 'its' : 'their'} own.`, MAX_REASON_CHARS), quote: cutText(first.what, 160), sourceLabel: 'Home Depot page', ...(first.url ? { url: first.url } : {}) }]
      : [];
    return {
      ...brief,
      ask: `What ${models.length === 1 ? 'is' : 'are'} ${listOf(models)} in this bundle?`,
      reasons: [...settledReason, ...brief.reasons].slice(0, 3),
      check: narrowCheck(narrow.unsettled, total),
    };
  }
  return { ...brief, check: cardCheck(brief.check, question.kind, brief.state, followUp) };
}

/** The brief of an eBay question: there is no AI suggestion for it, so it says what is asked and where to look. */
export function ebayBrief(question: EbayQuestion): ReviewBrief {
  return {
    ask: 'Is this eBay listing the same product?',
    suggestion: null,
    state: 'none',
    reasons: question.reasons.length > 0 ? question.reasons.slice(0, 3).map((r) => ({ text: cutText(r, MAX_REASON_CHARS) })) : [],
    check: { text: 'Open the eBay listing and see that it is this exact part, new.', who: 'owner', ...(question.url ? { url: question.url, linkLabel: 'eBay listing' } : {}) },
    writtenBy: 'rules',
  };
}
