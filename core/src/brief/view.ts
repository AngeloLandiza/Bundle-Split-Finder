// The brief the app shows for one open question (GET /api/review): the one a model wrote for the live suggestion and the
// code checked, when there is one; otherwise the rules' own. Pure: it reads only what the question and its suggestion hold.
// Step 16: a check the app's own tools can do (who.ts) is never shown as an instruction: cardCheck puts in its place what
// the app is doing about it or already did (the question's follow-up loop).

import type { StoredSuggestion } from '../assist/stored';
import type { ReviewFollowUp } from '../research/followUp';
import type { EbayQuestion, ReviewItem } from '../scan/types';
import { briefInputOf, poolOfLines, type BriefSourceLink } from './input';
import { cutText, MAX_CHECK_CHARS, MAX_REASON_CHARS, rulesBrief } from './rules';
import type { BriefCheck, BriefState, ReviewBrief } from './types';
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

/** The brief of a split or match question. `live` is the suggestion made for the question as it is now, or null. */
export function briefForQuestion(
  question: ReviewItem,
  live: StoredSuggestion | null,
  evidence: readonly { text: string; source: { label: string; url: string | null } }[],
  sources: readonly BriefSourceLink[],
  followUp?: ReviewFollowUp,
): ReviewBrief {
  const brief = live?.brief ?? rulesBrief(briefInputOf(question, live?.suggestion ?? null, poolOfLines(evidence), sources));
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
