// npm run keepa:budget — free when the file cache already has a Keepa product response.

import { KeepaBudgetExceededError } from '../core/src/keepa/client';
import { NoKeepaKeyError, openKeepaDev } from './open-keepa-dev';
import { loadEnv } from './node-store';

loadEnv();

const row = (label: string, value: string | number) => console.log(`  ${label.padEnd(22)}${value}`);

try {
  const reserve = Number(process.env.KEEPA_RESERVE);
  const reserveN = Number.isFinite(reserve) && reserve >= 0 ? reserve : 5;
  const { client, budget, release } = await openKeepaDev(100);
  try {
    const probe = await client.getProducts(['B0BGYFTPGK'], 1, {
      label: 'budget:probe',
      estimate: 1,
      maxAgeMs: Number.POSITIVE_INFINITY,
    });
    const balance = budget.knownBalance ?? probe.meta.tokensLeft;
    const refill = budget.refillRatePerMinute;

    console.log('\nKeepa account (from last response meta)');
    row('Tokens left', balance ?? 'unknown');
    row('Refill (per min)', refill ?? 'unknown');
    row('Reserve (dev)', reserveN);
    row('Spent this probe', probe.meta.tokensConsumed);

    if (balance === null) {
      console.log('\n  Balance unknown until a live Keepa response. Run keepa:record once (small cost).');
    } else {
      const spendable = Math.max(0, balance - reserveN);
      console.log('\nRight now');
      row('Above reserve', spendable);
      row('May spend (est. 1)', budget.canSpend(1) ? 'yes' : 'no');
      if (!budget.canSpend(1)) {
        const why = budget.blockReason(1);
        console.log(`  Blocked: ${why ?? 'run cap'}`);
      }
    }
    console.log('');
  } finally {
    release();
  }
} catch (err) {
  if (err instanceof NoKeepaKeyError) {
    console.error(err.message);
    process.exit(1);
  }
  if (err instanceof KeepaBudgetExceededError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}