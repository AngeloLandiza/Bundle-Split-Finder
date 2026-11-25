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

/** Nov 25, key stacking: one saved Keepa key's balance as its own last answer said, and whether Keepa refused it. */
interface KeyTokens {
  left: number;
  rate: number;
  out: boolean;
}

export class TokenBudget {
  private spent = 0;
  private tokensLeft: number | null = null;
  private refillRate: number | null = null;
  /** Key stacking: each key's balance, once an answer named its key (noteMeta with a key id). */
  private readonly keys = new Map<string, KeyTokens>();

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
  /** Tokens on the account; with several keys, the sum of the keys still accepted. */
  get knownBalance(): number | null {
    return this.tokensLeft;
  }
  /** Tokens refilled a minute; with several keys, the sum. */
  get refillRatePerMinute(): number | null {
    return this.refillRate;
  }

  /** Called after each successful Keepa response; `keyId` (key stacking) names the saved key it came from. */
  noteMeta(tokensLeft: number, tokensConsumed: number, refillRate: number, keyId?: string): void {
    if (tokensConsumed > 0) this.spent += tokensConsumed;
    if (keyId === undefined) {
      this.tokensLeft = tokensLeft;
      this.refillRate = refillRate;
      return;
    }
    this.keys.set(keyId, { left: tokensLeft, rate: refillRate, out: this.keys.get(keyId)?.out ?? false });
    this.sumKeys();
  }

  /** Keepa refused this key (401): its tokens count for nothing more in this run. */
  markOut(keyId: string): void {
    this.keys.set(keyId, { ...(this.keys.get(keyId) ?? { left: 0, rate: 0 }), out: true });
    this.sumKeys();
  }

  private sumKeys(): void {
    const live = [...this.keys.values()].filter((k) => !k.out);
    this.tokensLeft = live.reduce((n, k) => n + k.left, 0);
    this.refillRate = live.reduce((n, k) => n + k.rate, 0);
  }

  /** Estimate before the first response: only the run cap applies. */
  blockReason(estimate = 1): TokenBlockReason | null {
    if (this.spent + estimate > this.policy.maxPerRun) return 'run_cap';
    if (this.tokensLeft !== null) {
      // Key stacking: a request is made with one key, so one key must hold its tokens; the reserve is on the total.
      const most = this.keys.size > 0 ? Math.max(0, ...[...this.keys.values()].filter((k) => !k.out).map((k) => k.left)) : this.tokensLeft;
      if (most < estimate) return 'no_tokens';
      if (this.tokensLeft - estimate < this.policy.reserve) return 'reserve';
    }
    return null;
  }

  canSpend(estimate = 1): boolean {
    return this.blockReason(estimate) === null;
  }

  /**
   * Key stacking: the key a request of `estimate` tokens uses: the one with the most tokens that holds enough, not refused;
   * the earlier key on a tie. While no key's balance is known yet (before the first answer), the first key not refused.
   * Null when no key can pay.
   */
  pickKey(ids: readonly string[], estimate = 1): string | null {
    const usable = ids.filter((id) => !this.keys.get(id)?.out);
    const known = usable.filter((id) => this.keys.has(id));
    if (known.length === 0) return usable[0] ?? null;
    let best: string | null = null;
    for (const id of known) {
      const k = this.keys.get(id)!;
      if (k.left < estimate) continue;
      if (best === null || k.left > this.keys.get(best)!.left) best = id;
    }
    return best;
  }

  /** Each key's balance as this run knows it. */
  get byKey(): { id: string; tokensLeft: number; refillRate: number; out: boolean }[] {
    return [...this.keys.entries()].map(([id, k]) => ({ id, tokensLeft: k.left, refillRate: k.rate, out: k.out }));
  }
}

/**
 * Key stacking: how long until a request of `need` tokens can be made, in whole minutes, when each key refills on its own:
 * the soonest a single key holds `need` (a request uses one key), and no sooner than the total is `need` above the reserve
 * (the reserve is on the total). 0 when it can be made now. With one key this is the wait before key stacking.
 */
export function minutesUntilTokens(keys: readonly { tokensLeft: number; refillRate: number }[], need: number, reserve: number): number {
  if (keys.length === 0) return 0;
  const rate = (r: number) => (r > 0 ? r : 1);
  const perKey = Math.min(...keys.map((k) => (k.tokensLeft >= need ? 0 : Math.ceil((need - k.tokensLeft) / rate(k.refillRate)))));
  const total = keys.reduce((n, k) => n + k.tokensLeft, 0);
  const totalRate = keys.reduce((n, k) => n + rate(k.refillRate), 0);
  const short = need + reserve - total;
  const forReserve = short > 0 ? Math.ceil(short / totalRate) : 0;
  return Math.max(perKey, forReserve);
}