// The review assistant (step 11, Ask AI): a language model drafts an answer to one Review question
// for the owner to approve. A suggestion is never an answer (CLAUDE.md rule 4): nothing here writes
// to the store, and only the owner's Approve turns a suggestion into a ReviewAnswer.
//
// This file is the provider-neutral contract. The evidence is only what the scan already stored (no
// fetching, no search); the model's answer is read by verify.ts, which decides what it is worth.

import type { NotJudged, TokenUsage } from '../judge/types';

/** One line of a source, as the model is shown it and as a quote is searched in. */
export interface EvidenceLine {
  /** What the line is: a page's title, its model number, one of its specification lines, its description; a listing's title or brand field. */
  field: 'title' | 'model' | 'bullet' | 'description' | 'brand';
  text: string;
  /**
   * The line reads as words written to an AI (looksLikeInstruction). It is still shown, as data, but a
   * quote from it is never evidence, and while any line is suspect no choice is verified.
   */
  suspect?: true;
}

/** One place quotes may come from: a Home Depot page or an Amazon listing. */
export interface EvidenceSource {
  /** `bundle`, `kit:<MODEL>`, or `listing:<ASIN>`: what the model names as a quote's source. */
  id: string;
  kind: 'bundle' | 'kit' | 'listing';
  /** The link text the panel shows next to a quote ("Home Depot page", "Amazon listing"). */
  label: string;
  /** The source's own page; null when the scan stored none. */
  url: string | null;
  /** A kit page's model, a listing's ASIN: who the source is about. Not quotable. */
  model?: string;
  asin?: string;
  lines: EvidenceLine[];
}

/** Context about the question that is not quotable: the tool's own words, never a page's. */
export interface EvidenceNote {
  /** The listing a note is about (match questions), or absent for the question itself. */
  asin?: string;
  text: string;
}

/** Everything a suggestion may rest on, for one question. Built only from stored records. */
export interface AssistEvidence {
  questionId: string;
  kind: 'split' | 'match';
  brand: string;
  /** The bundle's model (split) or the part's (match). */
  model: string;
  /** Match questions: every way the part's model may be written (modelForms), the model first. */
  modelForms: string[];
  /** Match questions: the part's Home Depot name, when the catalog has it. */
  partName?: string | null;
  sources: EvidenceSource[];
  notes: EvidenceNote[];
  /** What the scan has not stored, in plain words ("The bundle's page was not read."). */
  missing: string[];
}

export type AssistDecision = 'choose' | 'none' | 'cannot_tell';

/** The model's answer, as the schema shapes it. Nothing in it is trusted until verify.ts has read it. */
export interface AssistRaw {
  evidence: { quote: string; source: string }[];
  reason: string;
  decision: AssistDecision;
  /** Split questions: the chosen reading's index into the question's choices. */
  choiceIndex: number | null;
  /** Match questions: the chosen candidate's ASIN. */
  asin: string | null;
}

/** A quote found verbatim in the source it names. */
export interface VerifiedQuote {
  quote: string;
  sourceId: string;
  label: string;
  url: string | null;
  /** The quote names a model of the chosen answer (or the part's model, for a match). */
  names: boolean;
}

/** What the owner would be asked to approve. For a split the reading's parts; for a match the listing. */
export type SuggestedAnswer =
  | { decision: 'choose'; kind: 'split'; choiceIndex: number; parts: string[] }
  | { decision: 'choose'; kind: 'match'; asin: string; title: string }
  | { decision: 'none' };

/** The model's answer after the code's check. */
export type CheckedSuggestion =
  /** Every quote was found in the source it names, the choice is one offered, and the quotes name it. Still only a suggestion. */
  | { status: 'verified'; answer: SuggestedAnswer; quotes: VerifiedQuote[]; reason: string }
  /** The model gave an answer the code could not confirm. Shown as unverified; it preselects nothing. */
  | { status: 'unverified'; reasons: string[]; claimed: AssistRaw | null }
  /** The model said the evidence does not settle it. Only quotes that were found are kept. */
  | { status: 'cannot_tell'; reason: string; quotes: VerifiedQuote[] };

interface SuggestionMeta {
  questionId: string;
  /** reviewSignature of the question as it was asked: a suggestion for a question that has changed since is stale. */
  seen: string;
  provider: string;
  model: string;
  promptVersion: string;
  usage?: TokenUsage;
}

/** One Ask AI result. `not_suggested`: no call was made, or the call gave no answer. */
export type Suggestion = (SuggestionMeta & CheckedSuggestion) | (SuggestionMeta & { status: 'not_suggested'; reason: string; notSuggested?: NotJudged });

/** The prompt of one Ask AI call, whatever the provider. */
export interface AssistRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

/** One model call's result: the answer text, or why there is none. */
export type AssistCallResult = { ok: true; answer: string; usage: TokenUsage } | { ok: false; notJudged: NotJudged; usage?: TokenUsage };

/**
 * A model that answers one Ask AI request. One call, no retries. Never throws for a provider or
 * network failure: it returns ok: false.
 */
export interface AssistModel {
  readonly provider: string;
  readonly model: string;
  ask(request: AssistRequest, signal?: AbortSignal): Promise<AssistCallResult>;
}
