import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { plainReason, plainVerification } from '../src/assist/plain';

// Step 15, rule 5: why an AI answer was not verified, in one plain sentence for the owner, on the reasons the verifiers
// gave on the owner's real data (fixtures/e2e-2026-11-23/store/suggestions.json, 21 suggestions after his second scan).

const SUGGESTIONS = JSON.parse(readFileSync(new URL('../../fixtures/e2e-2026-11-23/store/suggestions.json', import.meta.url), 'utf8')) as {
  questionId: string;
  suggestion: { status: string; reasons?: string[] };
}[];
const reasonsOf = (id: string) => SUGGESTIONS.find((s) => s.questionId === id)!.suggestion.reasons!;

describe('plain verification sentences', () => {
  it('every reason the verifiers gave on the real data has a plain form', () => {
    const all = SUGGESTIONS.flatMap((s) => s.suggestion.reasons ?? []);
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((r) => plainReason(r) === null)).toEqual([]);
  });

  it('DCK240C2DCS380B (306554196): the page never names the kit', () => {
    expect(plainVerification(reasonsOf('split:homedepot:306554196'))).toBe('Not verified: the page never names DCK240C2. Check the Home Depot page.');
  });

  it('PCL1600K2-A986501 (320243671): the title names a drill none of the parts is', () => {
    expect(plainVerification(reasonsOf('split:homedepot:320243671'))).toBe('Not verified: the title names a drill, and none of these parts is one. Check the Home Depot page.');
  });

  it('PCL1201K2-FVF51K (344284100): at most two reasons, the count of the rest, and where to check', () => {
    expect(plainVerification(reasonsOf('split:homedepot:344284100'))).toBe(
      'Not verified: the bundle says 2 tools, and these parts make 3; "Batteries" counts 1 battery, and PCL1201K2 holds 2; 3 more in Activity. Check the Home Depot page.',
    );
  });

  it('a reason it does not know is never guessed at', () => {
    expect(plainVerification(['Something new the verifier says.'])).toBe("Not verified: the AI's answer did not pass the checks. Check the Home Depot page.");
    expect(plainVerification(['No quote from listing B0B3JWF5ZV names PCL206.'], 'match')).toBe('Not verified: listing B0B3JWF5ZV never names PCL206. Check the Amazon listing.');
  });
});
