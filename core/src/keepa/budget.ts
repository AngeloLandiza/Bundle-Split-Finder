// Keepa token budget: every paid request goes through the client, which updates token
// balance from Keepa's meta fields (refillRate, tokensLeft).

export interface TokenPolicy {
  /** Tokens that must stay on the account after any spend in this run. */
  reserve: number;
  /** Most tokens a single scan or test session may spend. */
  maxPerRun: number;
}

export type TokenBlockReason = 'reserve' | 'run_cap' | 'no_tokens';

export const TOKEN_BLOCK_MESSAGE: Record<TokenBlockReason, string> = {
  reserve: 'This run would use Keepa tokens below the reserve.',
  run_cap: 'This run has reached its Keepa token limit.',
  no_tokens: 'Keepa returned no tokens left.',
};

export class TokenBudget {
  private spent = 0;
  private tokensLeft: number | null = null;
  private refillRate: number | null = null;

  constructor(
    private readonly policy: TokenPolicy,
    /** Last known account balance (extension prefs) so reserve applies before the first live response. */
    initialTokensLeft?: number | null,
  ) {
    if (initialTokensLeft != null && Number.isFinite(initialTokensLeft)) this.tokensLeft = initialTokensLeft;
  }

  get spentThisRun(): number {
    return this.spent;
  }
  get knownBalance(): number | null {
    return this.tokensLeft;
  }
  get refillRatePerMinute(): number | null {
    return this.refillRate;
  }

  /** Called after each successful Keepa response. */
  noteMeta(tokensLeft: number, tokensConsumed: number, refillRate: number): void {
    this.tokensLeft = tokensLeft;
    this.refillRate = refillRate;
    if (tokensConsumed > 0) this.spent += tokensConsumed;
  }

  /** Estimate before the first response: only the run cap applies. */
  blockReason(estimate = 1): TokenBlockReason | null {
    if (this.spent + estimate > this.policy.maxPerRun) return 'run_cap';
    if (this.tokensLeft !== null) {
      if (this.tokensLeft < estimate) return 'no_tokens';
      if (this.tokensLeft - estimate < this.policy.reserve) return 'reserve';
    }
    return null;
  }

  canSpend(estimate = 1): boolean {
    return this.blockReason(estimate) === null;
  }
}