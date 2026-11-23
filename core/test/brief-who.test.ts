// Step 16: the card's check line is only for what needs a person (core/src/brief/who.ts, view.ts cardCheck). The check
// that started it is the owner's real card of Nov 23 for PCL406424SB-A21701-A25RS51.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { StoredSuggestion } from '../src/assist/stored';
import { briefForQuestion, cardCheck, ebayBrief } from '../src/brief/view';
import type { ReviewBrief } from '../src/brief/types';
import { checkWho } from '../src/brief/who';
import { reviewSignature } from '../src/scan/answers';
import type { EbayQuestion, ReviewItem } from '../src/scan/types';

const REAL_CHECK = 'On the Home Depot page, see whether the Includes list names the accessories sold as A21701 and A25RS51.';
const scan3 = JSON.parse(readFileSync('fixtures/e2e-2026-11-23/after-scan3/store/review.json', 'utf8')) as { questions: ReviewItem[] };
const ITEM = scan3.questions.find((q) => q.id === 'split:homedepot:335724135')!;

describe('who a check is for', () => {
  it('a page read, an Includes read, a model or listing lookup is the app\'s; the rest is the owner\'s', () => {
    expect(checkWho(REAL_CHECK, 'split')).toBe('app');
    expect(checkWho('Read the Includes list on the Home Depot page and see what the bundle holds.', 'split')).toBe('app');
    expect(checkWho('Open the Amazon listings and see which one is this exact part, new.', 'match')).toBe('app');
    expect(checkWho('Look up DCB606 to see whether it is a battery.', 'split')).toBe('app');
    expect(checkWho('Decide whether you want to resell the tool bag on its own.', 'split')).toBe('owner');
    // The app has no tool that reads an eBay listing for him.
    expect(checkWho('Open the eBay listing and see that it is this exact part, new.', 'ebay')).toBe('owner');
    expect(ebayBrief({ id: 'e', key: 'k', brand: 'RYOBI', model: 'P108', title: 't', url: null, reasons: [] } as unknown as EbayQuestion).check?.who).toBe('owner');
  });

  it('the brief\'s app check never reaches the card as an instruction: it says what the app is doing, or did', () => {
    const brief: ReviewBrief = {
      ask: 'What is inside this bundle?', suggestion: null, state: 'cannot_tell', writtenBy: 'ai',
      reasons: [{ text: 'AI could not tell. The page lists a router and a sander, but never ties A21701 or A25RS51 to a named item.' }],
      // A brief stored before step 16 has no `who`.
      check: { text: REAL_CHECK, url: 'https://www.homedepot.com/p/335724135', linkLabel: 'Home Depot page' } as ReviewBrief['check'],
    };
    const live = { key: 'k', questionId: ITEM.id, seen: reviewSignature(ITEM), askedAt: 1, costUsd: 0.07, brief,
      suggestion: { questionId: ITEM.id, seen: reviewSignature(ITEM), provider: 'claude', model: 'claude-opus-5-5', promptVersion: 'p', status: 'cannot_tell', reason: 'r', quotes: [] } } as StoredSuggestion;
    const running = briefForQuestion(ITEM, live, [], [], { state: 'running', doing: "Reading Home Depot's page for A21701", tried: [], roundsLeft: 2 });
    expect(running.check).toEqual({ text: "Reading Home Depot's page for A21701.", who: 'app', url: 'https://www.homedepot.com/p/335724135', linkLabel: 'Home Depot page' });
    const after = briefForQuestion(ITEM, live, [], [], {
      state: 'gave_up', roundsLeft: 1,
      tried: [{ what: 'Searched Home Depot for RYOBI A21701', result: 'found: 5 in. 7-Piece Random Orbit Sand Paper Assortment Set', url: 'https://www.homedepot.com/p/317000001' }],
    });
    expect(after.check?.who).toBe('app');
    expect(after.check?.text).toBe('The app already read what it could for this (1 step); what it found is listed with this question, and the answer is your call.');
    const none = briefForQuestion(ITEM, live, [], []);
    for (const b of [running, after, none]) {
      expect(b.check?.text).not.toContain('see whether');
      expect(b.check?.text).not.toContain(REAL_CHECK);
    }
    // An owner's check stays as written.
    expect(cardCheck({ text: 'Decide whether you want to resell the tool bag on its own.', who: 'owner' }, 'split', 'not_verified')).toEqual({ text: 'Decide whether you want to resell the tool bag on its own.', who: 'owner' });
  });
});
