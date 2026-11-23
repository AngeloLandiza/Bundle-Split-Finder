// `?mock=real-ai`: the owner's PCL406424SB-A21701-A25RS51 question in each state of the app's own follow-up (queued, running,
// done, gave up), so the card can be seen in all four. The question, its page, its choice and the AI's first answer are the
// real ones (fixtures/e2e-2026-11-23, after-scan3). What the app "tried" and what it found are INVENTED for this mock: the
// agent does not send a follow-up yet. Each copy's model says which state it shows, so the list tells them apart.

import type { AiSuggestion, FollowUp, ReviewBrief, ReviewQuestion } from './types';

const MODEL = 'PCL406424SB-A21701-A25RS51';

// Invented: what a follow-up of this question would have done. Home Depot's real product names for A21701 and A25RS51
// are not in the recorded data; these two are stand-ins.
const SEARCH_ROUTER_BITS = { what: 'Searched Home Depot for RYOBI A21701', result: 'found: 15-Piece Router Bit Set' };
const SEARCH_SANDPAPER = { what: 'Searched Home Depot for RYOBI A25RS51', result: 'found: 5 in. Sandpaper Assortment, 18 pack' };

/** The copy of a real question that shows one state; `rest` is what differs. */
function copyOf(q: ReviewQuestion, tag: string, rest: Partial<ReviewQuestion>): ReviewQuestion {
  return { ...q, id: `${q.id}~${tag}`, bundle: { ...q.bundle, model: `${q.bundle.model} [${tag}]` }, ...rest };
}

/**
 * The four follow-up copies of the real question `q` (a "could not tell" the AI gave). Returned after the question itself,
 * which stays as the owner saw it (no follow-up).
 */
export function followUpVariants(q: ReviewQuestion): ReviewQuestion[] {
  if (q.bundle.model !== MODEL || q.suggestion?.status !== 'cannot_tell') return [];
  const link = q.bundle.link ?? undefined;
  const hd = (path: string) => `https://www.homedepot.com/s/${path}`;
  const stillMissing = 'The Includes list names no model for the router bits or the sandpaper, but whether the two accessory numbers are in this box is not settled.';
  const gaveUpSuggestion: AiSuggestion = { ...q.suggestion, reason: stillMissing };
  // Done: the app read the page and found something the AI can suggest, though the code could not verify it.
  const doneSuggestion: AiSuggestion = {
    status: 'unverified',
    choiceId: q.choices[0]?.id ?? null,
    answer: 'PCL406424SB + A21701 + A25RS51',
    reason: 'The page says the kit ships with a router and a sander, and the app found A21701 as a router bit set and A25RS51 as sandpaper.',
    notVerified: 'The page never names A21701 or A25RS51.',
    plain: 'Not verified: the page never names A21701; the page never names A25RS51. Check the Home Depot page.',
    quotes: q.suggestion.quotes,
    costUsd: 0.07,
  };
  // The agent's own brief for the done copy: what is left is a call that is his, so it says "Check", with who: 'owner'.
  const doneBrief: ReviewBrief = {
    ask: 'What is inside this bundle?',
    suggestion: 'PCL406424SB kit + A21701 router bits + A25RS51 sandpaper',
    state: 'not_verified',
    reasons: [
      { text: 'Home Depot sells A21701 as a router bit set and A25RS51 as a sandpaper pack.', ...(link ? { url: hd('A21701'), sourceLabel: 'Home Depot' } : {}) },
      { text: 'The kit page lists a router and a sander, and the accessories as "w/ Accessories".', ...(link ? { url: link, sourceLabel: 'Home Depot page' } : {}) },
    ],
    check: { text: 'Decide whether the two accessories are worth listing separately.', who: 'owner' },
    writtenBy: 'ai',
  };

  const queued: FollowUp = { state: 'queued', tried: [], roundsLeft: 3 };
  const running: FollowUp = { state: 'running', doing: "Reading Home Depot's page for A21701", tried: [{ ...SEARCH_ROUTER_BITS, url: hd('A21701') }], roundsLeft: 2 };
  const done: FollowUp = {
    state: 'done',
    tried: [
      { ...SEARCH_ROUTER_BITS, url: hd('A21701') },
      { ...SEARCH_SANDPAPER, url: hd('A25RS51') },
      { what: "Read Home Depot's page for the kit", result: 'the Includes list names the router and the sander', ...(link ? { url: link } : {}) },
      { what: 'Looked up A21701 on Amazon', result: 'found: a router bit set, not sold as a part of this kit' },
    ],
    roundsLeft: 1,
  };
  const gaveUp: FollowUp = {
    state: 'gave_up',
    tried: [
      { ...SEARCH_ROUTER_BITS, url: hd('A21701') },
      { what: "Read Home Depot's page for the kit", result: 'the Includes list names no model number', ...(link ? { url: link } : {}) },
    ],
    roundsLeft: 0,
  };

  // The agent's round-2 fields: Home Depot's own page confirmed A21701 (its name and link are the real ones); PCL406424SB is a
  // special buy and A25RS51 is not sold on Home Depot on its own, so the question is still about those two.
  const settledParts = [{ model: 'A21701', what: '7-Piece 5 in. Random Orbit Sand Paper Assortment Set', url: hd('A21701') }];
  const unsettledParts = ['PCL406424SB', 'A25RS51'];
  const waiting: FollowUp = { state: 'running', doing: 'Waiting for Chrome to read the Home Depot pages this needs', tried: [], roundsLeft: 2 };

  return [
    copyOf(q, 'queued', { followUp: queued }),
    copyOf(q, 'running', { followUp: running }),
    copyOf(q, 'done', { followUp: done, suggestion: doneSuggestion, brief: doneBrief }),
    copyOf(q, 'gave up', { followUp: gaveUp, suggestion: gaveUpSuggestion }),
    copyOf(q, 'settled', { settledParts, unsettledParts }),
    copyOf(q, 'settled, waiting', { settledParts, unsettledParts, followUp: waiting }),
  ];
}
