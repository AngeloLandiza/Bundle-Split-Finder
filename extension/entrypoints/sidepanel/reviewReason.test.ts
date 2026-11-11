import { describe, expect, it } from 'vitest';
import { reviewReason } from './reviewReason';

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
    ['page names DCF850, DCF921B, which do not fit the model number', 'The Home Depot page names DCF850, DCF921B, which does not fit the model number.'],
    ['page names no models', 'The Home Depot page names no parts.'],
    ['page does not name DCB606', 'The Home Depot page does not name DCB606.'],
  ];
  it.each(cases)('%s', (note, plain) => {
    expect(reviewReason(note)).toBe(plain);
  });

  it('turns the two halves of a disagreement into two sentences', () => {
    expect(reviewReason('model number says DCB606, DCK200D1P1; page says DCF921B, DCK200D1P1')).toBe(
      'The model number says DCB606, DCK200D1P1. The Home Depot page says DCF921B, DCK200D1P1.',
    );
  });

  it('joins several notes with a space', () => {
    expect(reviewReason('model number says DCB606; page names DCF921B, which do not fit the model number')).toBe(
      'The model number says DCB606. The Home Depot page names DCF921B, which does not fit the model number.',
    );
  });

  it('shows a note it does not know with a capital and a final period', () => {
    expect(reviewReason('no splitting rules for ACME yet')).toBe('No splitting rules for ACME yet.');
    expect(reviewReason('Already a sentence.')).toBe('Already a sentence.');
  });
});
