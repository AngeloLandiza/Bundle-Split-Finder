// The recordings served as eBay and as the model (scripts/ebay-replay.ts) read back as what was recorded, and the
// canned answers are what the checks make of them. No network.

import { describe, expect, it } from 'vitest';
import { parseItem, parseSearch } from '../src/ebay/parse';
import { judgeListingFromEbay } from '../src/judge/fromEbay';
import { verifyJudgement } from '../src/judge/verify';
import { anthropicAnswer, browseItem, browseSearch, cannedRaw, listingOfRequest, recordedEbay } from '../../scripts/ebay-replay';
import { renderJudgeInput } from '../src/judge/prompt';

describe('the eBay recording served in the Browse API shape', () => {
  it('every recorded search and item reads back as it was recorded', () => {
    let items = 0;
    for (const [model, part] of Object.entries(recordedEbay())) {
      expect(parseSearch(browseSearch(part.total, part.summaries)), model).toEqual(part.summaries);
      for (const item of Object.values(part.items)) {
        items += 1;
        expect(parseItem(browseItem(item)), `${model} ${item.itemId}`).toEqual(item);
      }
    }
    expect(items).toBeGreaterThan(100);
  });
});

describe('the canned model', () => {
  const dcf = recordedEbay().DCF921B!.items;
  const input = (id: string) => ({ part: { brand: 'DEWALT', model: 'DCF921B' }, listing: judgeListingFromEbay(dcf[id]!) });

  it('finds the listing a request is about by its title, and answers in the Messages API shape', () => {
    const id = 'v1|356061995376|0';
    const user = renderJudgeInput(input(id));
    expect(listingOfRequest(user)?.itemId).toBe(id);
    const { status, body } = anthropicAnswer({ messages: [{ role: 'user', content: user }] });
    expect(status).toBe(200);
    expect(body).toMatchObject({ stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 150 } });
  });

  it('its matches verify as matches, its unsure stays unsure, and everything else is not a match', () => {
    for (const id of ['v1|356061995376|0', 'v1|137923389067|0', 'v1|306552991202|0', 'v1|407209694810|0', 'v1|227617096880|0']) {
      expect(verifyJudgement(cannedRaw(dcf[id]!), input(id)), id).toMatchObject({ verdict: 'match', downgrades: [] });
    }
    expect(verifyJudgement(cannedRaw(dcf['v1|920101779170|0']!), input('v1|920101779170|0')).verdict).toBe('unsure');
    for (const id of ['v1|840092869695|0', 'v1|407352842496|0']) expect(verifyJudgement(cannedRaw(dcf[id]!), input(id)).verdict, id).toBe('not_match');
  });

  it('refuses a request about a listing it has no recording of', () => {
    expect(anthropicAnswer({ messages: [{ role: 'user', content: '<title>\nnothing\n</title>' }] }).status).toBe(400);
  });
});
