// npm run budget: what the account has, what this repo has spent, and what may be spent now.
// Costs nothing: the Account API is free.

import { SearchBudget } from '../core/src/serpapi/budget';
import { SerpApiClient } from '../core/src/serpapi/client';
import { DEV_ALLOCATION, type DevCategory } from './dev-budget';
import { reserve } from './dev-client';
import { loadEnv, spentThisMonth } from './node-store';

loadEnv();
const apiKey = process.env.SERPAPI_API_KEY ?? '';
if (!apiKey) {
  console.error('No SERPAPI_API_KEY. Copy .env.example to .env and paste your key.');
  process.exit(1);
}

const account = await SerpApiClient.account(apiKey);
const spent = spentThisMonth();
const row = (label: string, value: string | number) => console.log(`  ${label.padEnd(22)}${value}`);

console.log('\nSerpApi account');
row('Plan', `${account.planName} (${account.searchesPerMonth} a month, ${account.rateLimitPerHour} an hour)`);
row('Used this month', account.thisMonthUsage);
row('Left', account.totalSearchesLeft);
row('Used this hour', account.thisHourSearches);
row('Renews', account.renewalDate ?? 'not reported');

console.log('\nDevelopment plan (this repo, this month)');
for (const category of Object.keys(DEV_ALLOCATION) as DevCategory[]) {
  const used = spent[category] ?? 0;
  const cap = DEV_ALLOCATION[category];
  const state = used >= cap ? '  FULL' : '';
  row(category, `${used} of ${cap}${state}`);
}
row('reserve (never spent)', reserve());

const b = new SearchBudget(account, { reserve: reserve(), maxPerRun: Number.MAX_SAFE_INTEGER });
console.log('\nRight now');
row('Above the reserve', b.leftAboveReserve);
row('Left this hour', b.leftThisHour);
row('May be spent now', b.spendable);
if (b.spendable === 0) console.log(`  ${b.blockReason() === 'hourly_limit' ? 'Wait for the next hour.' : 'Nothing may be spent until the plan renews.'}`);
console.log('');
