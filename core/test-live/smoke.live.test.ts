// Opt-in live test: npm run test:live
// Spends at most 2 searches from the "live" allocation. Skips (does not fail)
// when there is no key or the budget is closed, and says why.

import { expect, test } from 'vitest';

import { pick } from '../src/match';
import { BudgetExceededError } from '../src/serpapi/client';
import { parseAmazonSearch } from '../src/serpapi/parsers';
import { NoKeyError, openDevClient } from '../../scripts/dev-client';

test('an Amazon search for a model number finds the listing the founder uses', async (ctx) => {
  let dev;
  try {
    dev = await openDevClient('live', 2);
  } catch (err) {
    if (err instanceof NoKeyError) return ctx.skip(err.message);
    throw err;
  }
  if (dev.allowance < 1) return ctx.skip('Budget closed: nothing may be spent right now. Run `npm run budget`.');

  try {
    const { data } = await dev.client.search({ engine: 'amazon', k: 'RYOBI PBLRC25B', amazon_domain: 'amazon.com' }, { label: 'live:amazon-search' });
    const picked = pick({ brand: 'RYOBI', model: 'PBLRC25B' }, parseAmazonSearch(data));
    expect(picked.chosen?.asin).toBe('B0B3JWF5ZV');
  } catch (err) {
    if (err instanceof BudgetExceededError) return ctx.skip(err.message);
    throw err;
  }
  expect(dev.budget.spentThisRun).toBeLessThanOrEqual(2);
});
