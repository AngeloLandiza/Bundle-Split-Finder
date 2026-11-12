import { describe, expect, it } from 'vitest';
import { partKey } from '@core/scan/types';
import { answeredKitWorld, kitRunPaid } from '../../../core/test/kit-world';
import { reviewReason, reviewReasonParts } from './reviewReason';

describe('reviewReason', () => {
  const cases: [string, string][] = [
    ['hyphen split, but a part is not in the catalog', 'The model number names its parts, but not all of them are known products yet.'],
    ['special-buy pattern, parts not in catalog', 'The model number looks like a special buy, but its parts are not known products yet.'],
    ['no known RYOBI bundle pattern', 'The model number does not show what is inside.'],
    ['no known DEWALT bundle pattern', 'The model number does not show what is inside.'],
    ["'CS565B' fits DCB205 and DCB606", 'Part of the model number fits more than one product: DCB205 or DCB606.'],
    ["'921B' can be split more than one way", 'The model number can be read more than one way.'],
    ["'CS334B' matches nothing in the catalog", 'Part of the model number matches no known product.'],
    ['model number says DCF921B', 'The model number says DCF921B.'],
    ['page names DCF850, DCF921B, which do not fit the model number', 'The Home Depot page names DCF850, DCF921B, which do not fit the model number.'],
    ['page names DCF850, which do not fit the model number', 'The Home Depot page names DCF850, which does not fit the model number.'],
    ['1 listing(s) show the model number, but the brand is not confirmed', 'One listing shows this model number, but its brand is not confirmed.'],
    ['3 listing(s) show the model number, but the brand is not confirmed', '3 listings show this model number, but their brand is not confirmed.'],
    ['page names no models', 'The Home Depot page names no parts.'],
    ['title says Replacement or OEM, which often marks a spare part', "Some of these listings say Replacement or OEM in their titles, which often means a spare part."],
    ['1 listing(s) show the model number, but the brand is not confirmed (3 more not shown)', 'One listing shows this model number, but its brand is not confirmed. 3 more listings are not shown.'],
    ['title says Replacement or OEM, which often marks a spare part (12 more not shown)', "Some of these listings say Replacement or OEM in their titles, which often means a spare part. 12 more listings are not shown."],
    ['page does not name DCB606', 'The Home Depot page does not name DCB606.'],
    // Ruling 71: the count of the listings a match question leaves out is its own note.
    ['17 more listing(s) not shown', '17 more listings are not shown.'],
    ['1 more listing(s) not shown', '1 more listing is not shown.'],
  ];
  it.each(cases)('%s', (note, plain) => {
    expect(reviewReason(note)).toBe(plain);
  });

  it('turns the two halves of a disagreement into two sentences', () => {
    expect(reviewReason('model number says DCB606, DCK200D1P1; page says DCF921B, DCK200D1P1')).toBe(
      'The model number says DCB606, DCK200D1P1. The Home Depot page says DCF921B, DCK200D1P1.',
    );
  });

  it('sets each model number apart and keeps the separators as words', () => {
    expect(reviewReasonParts("'CS565B' fits DCB205 and DCB606")).toEqual([
      { text: 'Part of the model number fits more than one product: ' },
      { model: 'DCB205' },
      { text: ' or ' },
      { model: 'DCB606' },
      { text: '.' },
    ]);
    expect(reviewReasonParts('model number says A1, B2')).toEqual([
      { text: 'The model number says ' }, { model: 'A1' }, { text: ', ' }, { model: 'B2' }, { text: '.' },
    ]);
  });

  it('joins several notes with a space', () => {
    expect(reviewReason('model number says DCB606; page names DCF921B, which do not fit the model number')).toBe(
      'The model number says DCB606. The Home Depot page names DCF921B, which does not fit the model number.',
    );
  });

  it("says P553's match question on the replay, its notes joined by \"; \", as three sentences", async () => {
    const w = await answeredKitWorld();
    expect(await kitRunPaid(w, { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'P553' }] })).toBeNull();
    const reason = (await w.store.getReview(`match:${partKey('RYOBI', 'P553')}`))!.reason;
    expect(reason).toBe(
      '22 listing(s) show the model number, but the brand is not confirmed; title says Replacement or OEM, which often marks a spare part; 17 more listing(s) not shown',
    );
    expect(reviewReason(reason)).toBe(
      "22 listings show this model number, but their brand is not confirmed. Some of these listings say Replacement or OEM in their titles, which often means a spare part. 17 more listings are not shown.",
    );
  });

  it('shows a note it does not know with a capital and a final period', () => {
    expect(reviewReason('no splitting rules for ACME yet')).toBe('No splitting rules for ACME yet.');
    expect(reviewReason('Already a sentence.')).toBe('Already a sentence.');
  });
});
