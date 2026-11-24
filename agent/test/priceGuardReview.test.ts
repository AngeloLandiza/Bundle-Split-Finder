import { describe, expect, it } from 'vitest';

import { replayScan5 } from '../../scripts/measure-wrong-confirm';
import { defaultSettings } from '../store';
import { reviewResponse } from '../views';

// The price guard's question in Review (agent/views.ts reviewResponse), on the replay of the owner's fifth scan with the
// example's match (scripts/measure-wrong-confirm.ts replayScan5): both links, so the owner can verify from the source.

describe('the held part in Review', () => {
  it('"Which listing" for DWST08017: the reason, Home Depot\'s page of the part sold alone and every Amazon listing offered', async () => {
    const { report } = await replayScan5();
    const view = reviewResponse({
      review: { at: null, questions: report.review, ebayQuestions: [] }, suggestions: [], deals: { bundles: report.bundles },
      settings: defaultSettings(),
    } as unknown as Parameters<typeof reviewResponse>[0]);
    const q = view.questions.find((x) => x.id === 'match:DEWALT:DWST08017')!;
    expect(q.reason).toBe("Amazon's price is 9.7× Home Depot's price for this part: check the listing");
    expect(q.bundleId).toBe('homedepot:339422000');
    expect(q.sources.map((s) => s.url)).toEqual([
      'https://www.homedepot.com/p/sets/DEWALT-Adaptor-Plate-for-TOUGHSYSTEM-2-0-and-10-Compartment-Shallow-Pro-Small-Parts-Organizer-DWST08017W14925/339422000',
      'https://www.homedepot.com/p/322961591',
      'https://www.amazon.com/dp/B0DGLWKS9S', 'https://www.amazon.com/dp/B0C3TN1Z7P', 'https://www.amazon.com/dp/B0HMV5V9L7', 'https://www.amazon.com/dp/B0HQQZWYTX',
    ]);
    expect(q.sources[1]!.label).toBe('Home Depot: DEWALT DWST08017 sold alone, $39.99');
  });
});
