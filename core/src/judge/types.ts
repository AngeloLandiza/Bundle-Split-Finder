// The listing judge: a language model asked whether one eBay listing is exactly one product (the
// item sold under a part's model number: a bare tool, a battery, a charger, a kit, a bit set). This file
// is the provider-neutral contract. An adapter (claude.ts first) turns a JudgeInput into one model
// call and hands back the model's answer text; verify.ts decides what that answer is worth. A second
// provider is a new adapter file and nothing else.

/** The part being valued. `twin` is the part's other written form (RYOBI PCL206 / PCL206B). */
export interface JudgePart {
  brand: string;
  model: string;
  twin?: string;
  /**
   * The part's name (Home Depot's title): says what the product is and what it includes, e.g.
   * "20V MAX Cordless Drill/Impact 2 Tool Combo Kit with (2) 20V 1.3Ah Batteries, Charger, and Bag".
   * Without it the model number alone defines the product.
   */
  title?: string;
}

/**
 * One eBay listing, as the scan maps it from its own listing type. Everything here except `itemId`,
 * `conditionId` and `price` is seller text: untrusted, shown to the model as data. Seller and buyer
 * fields never get here (no eBay user data).
 */
export interface JudgeListing {
  itemId: string;
  title: string;
  /** eBay's item specifics (localizedAspects), name and value. */
  aspects: { name: string; value: string }[];
  /** The description with its HTML removed. */
  descriptionText: string;
  mpn?: string;
  brand?: string;
  /** eBay's condition id; "1000" is New. */
  conditionId?: string | null;
  /** Kept for the caller, as EbayListing has it. Never shown to the model: a price is not evidence of identity. */
  price?: number | null;
  currency?: string;
}

export interface JudgeInput {
  part: JudgePart;
  listing: JudgeListing;
}

export type JudgeVerdict = 'match' | 'not_match' | 'unsure';

/** What a quote is offered as evidence of. */
export type EvidenceClaim = 'identity' | 'contents' | 'quantity' | 'condition' | 'extra' | 'missing' | 'not_the_product';

export const EVIDENCE_CLAIMS: readonly EvidenceClaim[] = ['identity', 'contents', 'quantity', 'condition', 'extra', 'missing', 'not_the_product'];

/** The model's answer, as the schema shapes it. Nothing in it is trusted until verify.ts has read it. */
export interface JudgeRaw {
  evidence: { claim: EvidenceClaim; quote: string }[];
  /**
   * True: the listing holds exactly what the product includes, nothing more, nothing less. False:
   * something is added or missing, or it is not the product. Null: the text does not say.
   */
  contentsMatch: boolean | null;
  /** Units of the product sold in the listing (one 2-pack battery is 1). */
  quantity: number | null;
  condition: 'new' | 'other' | null;
  /** Everything sold beyond the product, in short words ("battery", "charger", "case"). */
  extras: string[];
  /** Everything the product includes that the listing lacks, in short words. */
  missing: string[];
  reason: string;
  verdict: JudgeVerdict;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Why a call gave no judgement. None of these is a verdict: the listing simply was not judged, and
 * the scan carries on without it.
 */
export type NotJudgedReason =
  | 'auth' // 401, 403: the key is wrong or lacks access
  | 'rate_limited' // 429
  | 'overloaded' // 529
  | 'server' // other 5xx
  | 'bad_request' // 400: the request itself was refused
  | 'http' // any other status
  | 'network' // no answer from the provider
  | 'aborted'
  | 'bad_response' // an answer that is not the provider's response shape
  | 'refusal' // the model declined
  | 'max_tokens' // the answer was cut off
  | 'unexpected_stop'
  | 'no_answer'; // no text in the answer

export interface NotJudged {
  reason: NotJudgedReason;
  /** A plain sentence. Never holds the key, never the fetch error's own text. */
  message: string;
  status?: number;
  retryAfterSeconds?: number;
  refusalCategory?: string;
}

interface CallBase {
  judgeId: string;
  model: string;
  promptVersion: string;
}

/** One model call's result: the answer text, or why there is none. */
export type JudgeCall =
  | (CallBase & { ok: true; answer: string; usage: TokenUsage })
  | (CallBase & { ok: false; notJudged: NotJudged; usage?: TokenUsage });

/** A model that judges listings. `id` names the provider ("claude"), `model` the model id. */
export interface ListingJudge {
  readonly id: string;
  readonly model: string;
  /** One call, no retries. Never throws for a provider or network failure: it returns ok: false. */
  judge(input: JudgeInput, signal?: AbortSignal): Promise<JudgeCall>;
}

/** The judge's answer after verification. `verdict` is what the scan may use. */
export interface VerifiedJudgement {
  verdict: JudgeVerdict;
  /** What the judge said; null when its answer could not be read. */
  claimed: JudgeVerdict | null;
  raw: JudgeRaw | null;
  /** Why `verdict` is lower than `claimed`, one sentence each. Empty when nothing was changed. */
  downgrades: string[];
}

interface OutcomeBase extends CallBase {
  itemId: string;
}

/** A listing judged and verified, or a listing not judged. Only `judged` carries a verdict. */
export type JudgeOutcome =
  | (OutcomeBase & VerifiedJudgement & { kind: 'judged'; usage: TokenUsage })
  | (OutcomeBase & NotJudged & { kind: 'not_judged'; usage?: TokenUsage });
