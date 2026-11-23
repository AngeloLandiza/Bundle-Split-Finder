// One Home Depot doorway tab at a time (step 13, W5). Every reader opens the doorway, remembers its tab id, and closes a tab
// it finds remembered when it starts: two readers at once would close each other's tab. A scan this extension runs and a job
// the app queued both read through it, so each call to a reader goes through one lock, whoever asks.

import type { ListingAnswer } from './hdReader';
import type { ReadPages, ReadPartPrices } from '@core/scan/types';
import type { ToolError } from '@core/research/types';
import type { ListedItem, PromoPageOutcome } from '@core/tracking/bogoPairs';
import type { ReadItemPrice } from './hdReader';
import type { QuestionBudget, QuestionTools } from './researchTools';

/** Runs the functions it is given one after another, in the order given; one that throws does not stop the next. */
export type Lock = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLock(): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

/** What reads Home Depot in the owner's browser. */
export interface Readers {
  readPages: ReadPages;
  readPartPrices: ReadPartPrices;
  readItemPrice: ReadItemPrice;
  /** BOGO: one page of a Featured BOGO listing (hdReader.ts createBogoListingReader). Absent: this browser does not read them. */
  readBogoListing?: (path: string) => Promise<{ products: ListedItem[] } | ToolError>;
  /** Free scan: one page of a brand's Bundle listing (hdReader.ts createBundleListingReader). */
  readBundleListing?: (path: string) => Promise<ListingAnswer | ToolError>;
  /** BOGO: product pages with their promotions (createPromoPageReader). */
  readPromoPages?: (itemIds: string[]) => Promise<PromoPageOutcome[]>;
  researchTools: { forQuestion(budget?: QuestionBudget): QuestionTools };
}

/** The same readers, each call to a Home Depot page taken through `lock`. The local catalog lookup needs no tab and is not locked. */
export function lockedReaders(lock: Lock, raw: Readers): Readers {
  return {
    readPages: (ids) => lock(() => raw.readPages(ids)),
    readPartPrices: (parts) => lock(() => raw.readPartPrices(parts)),
    readItemPrice: (itemId, model) => lock(() => raw.readItemPrice(itemId, model)),
    ...(raw.readBogoListing ? { readBogoListing: (path: string) => lock(() => raw.readBogoListing!(path)) } : {}),
    ...(raw.readBundleListing ? { readBundleListing: (path: string) => lock(() => raw.readBundleListing!(path)) } : {}),
    ...(raw.readPromoPages ? { readPromoPages: (ids: string[]) => lock(() => raw.readPromoPages!(ids)) } : {}),
    researchTools: {
      forQuestion(budget) {
        const tools = raw.researchTools.forQuestion(budget);
        return {
          ...tools,
          readHomeDepotPage: (input, signal) => lock(() => tools.readHomeDepotPage(input, signal)),
          searchHomeDepot: (input, signal) => lock(() => tools.searchHomeDepot(input, signal)),
        };
      },
    },
  };
}
