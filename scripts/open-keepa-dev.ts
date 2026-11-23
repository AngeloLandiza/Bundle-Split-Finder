// The only way development code may reach Keepa. Shares the SerpApi spend lock so one
// process spends at a time.

import { TokenBudget } from '../core/src/keepa/budget';
import { KeepaClient } from '../core/src/keepa/client';
import { acquireSpendLock, appendLedger, FileCache, loadEnv } from './node-store';

export interface KeepaDevClient {
  client: KeepaClient;
  budget: TokenBudget;
  release: () => void;
}

export class NoKeepaKeyError extends Error {}

const reserve = (): number => {
  const fromEnv = Number(process.env.KEEPA_RESERVE);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 5;
};

export async function openKeepaDev(maxTokensThisSession: number): Promise<KeepaDevClient> {
  loadEnv();
  const apiKey = process.env.KEEPA_API_KEY ?? '';
  if (!apiKey) throw new NoKeepaKeyError('No KEEPA_API_KEY. Add it to .env.');

  const release = acquireSpendLock('keepa');
  try {
    const budget = new TokenBudget({ reserve: reserve(), maxPerRun: maxTokensThisSession });
    const client = new KeepaClient({
      apiKey,
      budget,
      cache: new FileCache(),
      onSpend: (entry) => {
        appendLedger({ at: entry.at, engine: 'keepa', label: entry.label, key: entry.key });
      },
    });
    return { client, budget, release };
  } catch (err) {
    release();
    throw err;
  }
}