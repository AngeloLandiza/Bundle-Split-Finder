// The only way development code may reach SerpApi.
//
// openDevClient() checks the real account first (free), then builds a client whose
// budget is the tightest of: the account reserve, this category's monthly allocation,
// the hourly limit, and the cap the caller asks for. If nothing may be spent it says why.
//
// It also takes the spend lock, so two processes (two subagents, two terminals, two git
// worktrees) can never spend at the same time. The second one gets a SpendLockError.

import { type AccountInfo, SearchBudget } from '../core/src/serpapi/budget';
import { SerpApiClient } from '../core/src/serpapi/client';
import { DEV_ALLOCATION, DEV_RESERVE, type DevCategory } from './dev-budget';
import { acquireSpendLock, appendLedger, FileCache, loadEnv, spentThisMonth } from './node-store';

export interface DevClient {
  client: SerpApiClient;
  budget: SearchBudget;
  account: AccountInfo;
  /** Searches this session may still spend. */
  allowance: number;
  /** Give up the spend lock. Also happens when the process exits. */
  release: () => void;
}

export class NoKeyError extends Error {}

export function reserve(): number {
  const fromEnv = Number(process.env.SERPAPI_RESERVE);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEV_RESERVE;
}

export async function openDevClient(category: DevCategory, maxThisSession: number): Promise<DevClient> {
  loadEnv();
  const apiKey = process.env.SERPAPI_API_KEY ?? '';
  if (!apiKey) throw new NoKeyError('No SERPAPI_API_KEY. Copy .env.example to .env and paste your key.');

  const release = acquireSpendLock(category); // throws if another process is spending
  try {
    const account = await SerpApiClient.account(apiKey); // free
    const leftInCategory = Math.max(0, DEV_ALLOCATION[category] - (spentThisMonth()[category] ?? 0));
    const budget = new SearchBudget(account, { reserve: reserve(), maxPerRun: Math.min(maxThisSession, leftInCategory) });
    const client = new SerpApiClient({ apiKey, budget, cache: new FileCache(), onSpend: appendLedger });
    return { client, budget, account, allowance: budget.spendable, release };
  } catch (err) {
    release(); // a bad key or a network error must not leave the lock behind
    throw err;
  }
}
