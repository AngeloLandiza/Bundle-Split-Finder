// The brief the app shows for one open question (GET /api/review): the one a model wrote for the live suggestion and the
// code checked, when there is one; otherwise the rules' own. Pure: it reads only what the question and its suggestion hold.

import type { StoredSuggestion } from '../assist/stored';
import type { EbayQuestion, ReviewItem } from '../scan/types';
import { briefInputOf, poolOfLines, type BriefSourceLink } from './input';
import { cutText, MAX_REASON_CHARS, rulesBrief } from './rules';
import type { ReviewBrief } from './types';

/** The brief of a split or match question. `live` is the suggestion made for the question as it is now, or null. */
export function briefForQuestion(
  question: ReviewItem,
  live: StoredSuggestion | null,
  evidence: readonly { text: string; source: { label: string; url: string | null } }[],
  sources: readonly BriefSourceLink[],
): ReviewBrief {
  if (live?.brief) return live.brief;
  return rulesBrief(briefInputOf(question, live?.suggestion ?? null, poolOfLines(evidence), sources));
}

/** The brief of an eBay question: there is no AI suggestion for it, so it says what is asked and where to look. */
export function ebayBrief(question: EbayQuestion): ReviewBrief {
  return {
    ask: 'Is this eBay listing the same product?',
    suggestion: null,
    state: 'none',
    reasons: question.reasons.length > 0 ? question.reasons.slice(0, 3).map((r) => ({ text: cutText(r, MAX_REASON_CHARS) })) : [],
    check: { text: 'Open the eBay listing and see that it is this exact part, new.', ...(question.url ? { url: question.url, linkLabel: 'eBay listing' } : {}) },
    writtenBy: 'rules',
  };
}
