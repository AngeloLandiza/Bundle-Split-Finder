import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { StoredSuggestion } from '../../core/src/assist/stored';
import type { ReviewItem } from '../../core/src/scan/types';
import { defaultSettings, type StoreData } from '../store';
import { reviewResponse } from '../views';

// Step 15, rule 5, on the owner's real Review after his second scan (fixtures/e2e-2026-11-23/store): each question whose
// AI answer was not verified says why in one plain sentence; the technical reasons stay on the suggestion.

const STORE = new URL('../../fixtures/e2e-2026-11-23/store/', import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, STORE), 'utf8')) as T;

describe('GET /api/review: suggestionPlain', () => {
  it('a question with an unverified suggestion carries the plain sentence; its reasons are kept', () => {
    const review = read<{ at: string; questions: ReviewItem[]; ebayQuestions: []; evidence: StoreData['review']['evidence'] }>('review.json');
    const suggestions = read<StoredSuggestion[]>('suggestions.json');
    const data = {
      review: { ...review, ebayQuestions: [] },
      suggestions,
      deals: { at: null, bundles: [], auditAt: null, auditBundles: [] },
      settings: defaultSettings(),
    } as unknown as Pick<StoreData, 'review' | 'suggestions' | 'deals' | 'settings'>;
    const qs = reviewResponse(data).questions;
    const q = qs.find((x) => x.id === 'split:homedepot:306554196')!;
    expect(q.suggestionPlain).toBe('Not verified: the page never names DCK240C2. Check the Home Depot page.');
    expect(q.suggestion?.suggestion).toMatchObject({ status: 'unverified', reasons: ["No quote from the bundle page's Includes, specification lines or description names DCK240C2."] });
    expect(qs.filter((x) => x.suggestion?.suggestion.status === 'unverified').every((x) => typeof x.suggestionPlain === 'string')).toBe(true);
  });
});
