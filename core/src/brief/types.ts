// The brief: a three-line summary above one Review question, so the owner reads a few plain sentences before the page
// quotes. Contract of GET /api/review (ReviewQuestion.brief). A brief explains the suggestion and never changes it:
// the answer, its status and what Autopilot may apply come from the assistant and the verifiers, not from here
// (CLAUDE.md rule 4). Two writers: the rules (rules.ts, always available, no model) and a cheap model (pipeline.ts)
// whose every sentence is checked by code (ground.ts) before it is kept.

/** verified: the code confirmed the suggestion; not_verified: it could not (or the AI said nothing fits); cannot_tell: the AI said the pages do not settle it; none: no suggestion. */
export type BriefState = 'verified' | 'not_verified' | 'cannot_tell' | 'none';

export interface BriefReason {
  /** One plain sentence, at most 110 characters. */
  text: string;
  /** The page text the sentence rests on, word for word (cut when long). */
  quote?: string;
  /** Where the quote is from ("Home Depot page", "Amazon listing"). */
  sourceLabel?: string;
  url?: string;
}

export interface BriefCheck {
  /** What the owner should look at. */
  text: string;
  url?: string;
  linkLabel?: string;
}

export interface ReviewBrief {
  /** The question: "What is inside this bundle?" */
  ask: string;
  /** The proposed answer in plain words ("PCL1600K2 kit + PBP2003 battery 2-pack"), or null when there is none. */
  suggestion: string | null;
  state: BriefState;
  /** At most 3. */
  reasons: BriefReason[];
  check: BriefCheck | null;
  /** 'ai': a model wrote it and the code checked every sentence; 'rules': built from the question and the verifier's words. */
  writtenBy: 'ai' | 'rules';
}

/** A line of a source the code found the suggestion's quote in: what a brief may rest on. */
export interface BriefQuote {
  /** The line, as the page shows it (cut when long). */
  text: string;
  /** The source the model named for it, when it named one the evidence has (`bundle`, `kit:<MODEL>`, `listing:<ASIN>`). */
  sourceId: string | null;
  label: string;
  url: string | null;
}

/** What the brief of one question is written from: only things the code already holds or has checked. */
export interface BriefInput {
  questionId: string;
  kind: 'split' | 'match';
  ask: string;
  brand: string;
  model: string;
  title: string | null;
  /** The tool's own words for why it asks. */
  note: string;
  /** The readings (split) or the listings (match: ASIN and title), as the question offers them. */
  options: string[];
  state: BriefState;
  /** The proposed answer in plain words, or null. */
  proposed: string | null;
  /** The models the proposed answer names: a brief's suggestion must name each. */
  proposedModels: string[];
  /** Sentences the code wrote about the suggestion: its plain verification reasons, or what its status means. */
  verdict: string[];
  /** The plain reasons alone (rules.ts words them as reasons), empty unless the suggestion was not verified. */
  plainReasons: string[];
  /** Quotes the code found word for word, numbered from 1 by position. */
  quotes: BriefQuote[];
  /** Where the owner can look, or null. */
  checkLink: { url: string; label: string } | null;
}

/** Why one sentence of a model's brief was dropped, or that it was kept. Printed by scripts/brief-eval.ts. */
export interface BriefVerdict {
  part: 'suggestion' | 'reason' | 'check';
  text: string;
  kept: boolean;
  /** Why not, in a sentence; absent when kept. */
  why?: string;
}
