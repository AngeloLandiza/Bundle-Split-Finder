import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type * as C from '@core/api/contract';
import { mapReview } from '../api/map';
import real from '../api/mockReal.json';
import { followUpVariants } from '../api/mockFollowUp';
import type { ReviewBrief, ReviewQuestion } from '../api/types';
import { noteOf } from '../lib/askAi';
import { briefFor } from '../lib/reviewBrief';
import { DecisionCard, WorkingCard } from './ReviewCard';
import { AskNoteLine } from './ReviewParts';

// The owner's real question (his screenshot): PCL406424SB-A21701-A25RS51, which the AI could not tell.
const third = mapReview((real as unknown as { scan3: { review: C.ReviewResponse } }).scan3.review).questions;
const real406 = third.find((q) => q.bundle.model === 'PCL406424SB-A21701-A25RS51')!;
const cannotTell: ReviewQuestion = {
  ...real406,
  suggestion: { status: 'cannot_tell', choiceId: null, answer: '', reason: 'The Includes list names no model, but whether the two accessory numbers are in this box is not settled.', quotes: [], costUsd: 0.06 },
};
const [queued, running, done, gaveUp] = followUpVariants(cannotTell) as [ReviewQuestion, ReviewQuestion, ReviewQuestion, ReviewQuestion];

const card = (q: ReviewQuestion, brief: ReviewBrief = briefFor(q)) =>
  renderToStaticMarkup(createElement(DecisionCard, { brief, id: 'c', fromAi: q.suggestion !== null, ...(q.followUp ? { followUp: q.followUp } : {}) }));
const READ_THE_PAGE = 'On the Home Depot page, see whether the Includes list names the accessories sold as A21701 and A25RS51';
const brief = (check: ReviewBrief['check']): ReviewBrief => ({ ask: 'What is inside this bundle?', suggestion: null, state: 'none', reasons: [{ text: 'Home Depot does not list the parts.' }], check, writtenBy: 'ai' });

describe('the card never tells him to do what the app can do', () => {
  it('shows no Check or Next for a read-the-page check, from the agent (who: app) or from its words alone', () => {
    for (const check of [{ text: READ_THE_PAGE, who: 'app' as const }, { text: READ_THE_PAGE }]) {
      const html = card(real406, brief(check));
      expect(html).not.toContain('Includes list');
      expect(html).not.toMatch(/>(Check|Next)</);
    }
  });
  it('shows the check when it needs a person, as Check (and as Next once the AI could not tell)', () => {
    const own = { text: 'Decide whether the two accessories are worth listing separately.', who: 'owner' as const };
    expect(card(real406, brief(own))).toMatch(/>Check<[^]*worth listing separately/);
    expect(card(cannotTell, { ...brief(own), state: 'cannot_tell' })).toMatch(/>Next<[^]*worth listing separately/);
  });
  it('the rules card for the real question has no read-the-page instruction either', () => {
    expect(card(real406)).not.toMatch(/>(Check|Next)</);
    expect(card(cannotTell)).toMatch(/>Next<[^]*Pick the parts below\./);
  });
});

describe('what the app already did', () => {
  it('done: at most three lines of what the app checked, each with its link, above Why; the rest said to be in Details', () => {
    const html = card(done);
    const block = html.slice(html.indexOf('What the app checked'), html.indexOf('>Why<'));
    expect(html.indexOf('What the app checked')).toBeGreaterThan(-1);
    expect(html.indexOf('What the app checked')).toBeLessThan(html.indexOf('>Why<'));
    expect(block.match(/<li>/g)).toHaveLength(3);
    expect(block).toContain('Searched Home Depot for RYOBI A21701 — found: 15-Piece Router Bit Set');
    expect(block).toMatch(/<a [^>]*href="https:\/\/www\.homedepot\.com\/s\/A21701"[^>]*>Home Depot/);
    expect(block).toContain('1 more in Details');
  });
  it('gave up: the sentence is what is still missing after those checks, then the checks, then only his pick', () => {
    const html = card(gaveUp);
    expect(html).toContain('Whether the two accessory numbers are in this box is not settled.');
    expect(html.indexOf('Whether the two')).toBeLessThan(html.indexOf('What the app checked'));
    expect(html).toContain('the Includes list names no model number');
    expect(html).toMatch(/>Next<[^]*Pick the parts below\./);
    expect(html).not.toContain('>Why<');
  });
  it('gave up with no AI answer at all still says it plainly, not "No suggestion yet"', () => {
    const none: ReviewQuestion = { ...gaveUp, suggestion: null };
    expect(card(none, brief(null))).toContain('Home Depot does not list the parts.');
    expect(card(none, brief(null))).not.toContain('No suggestion yet');
  });
});

describe('the working card', () => {
  it('says Working on it, what it is doing and what it has tried; it suggests nothing', () => {
    const html = renderToStaticMarkup(createElement(WorkingCard, { followUp: running.followUp!, id: 'c' }));
    expect(html).toContain('Working on it');
    expect(html).toContain('Reading Home Depot&#x27;s page for A21701');
    expect(html).toContain('Searched Home Depot for RYOBI A21701 — found: 15-Piece Router Bit Set');
    expect(html).toContain('class="spinner"');
    expect(html).not.toMatch(/Suggested|Verified/);
    expect(renderToStaticMarkup(createElement(WorkingCard, { followUp: queued.followUp!, id: 'c' }))).toContain('Waiting to start');
  });
});

describe('Ask AI is answered at once', () => {
  const q: ReviewQuestion = { ...cannotTell, askCostUsd: 0.07 };
  const line = (r: { queued: boolean; reason?: string }) => renderToStaticMarkup(createElement(AskNoteLine, { note: noteOf(r, q, 0), q, onForce: () => {} }));
  it('queued: Checking again with the spinner', () => {
    expect(line({ queued: true })).toMatch(/spinner[^]*Checking again…/);
  });
  it('nothing new: the reason and the one action, with its price', () => {
    const html = line({ queued: false, reason: 'Nothing new to read since the last answer.' });
    expect(html).toContain('Nothing new to read since the last answer.');
    expect(html).toMatch(/<button[^>]*>Ask anyway · about \$0\.07<\/button>/);
  });
  it('any other reason: said, with no action', () => {
    expect(line({ queued: false, reason: 'The app is already working on this one.' })).not.toContain('<button');
  });
});
