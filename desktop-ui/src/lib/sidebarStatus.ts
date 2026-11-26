// The foot of the sidebar says four things at most (docs/ux-checklist.md item 5 asks for the scan state always on screen;
// NN/g heuristic 8 asks for nothing more): the state, when the last or next scan is, what is left to spend, and one problem
// that links to where it is fixed. Everything else lives in Today's Agent card. Pure: the sidebar only draws it.

import type { AppState } from '../api/types';
import { count, when } from './format';
import { perKeySplit } from './keyEntries';
import { feeLookupWords, keepaWords, rejectedKeysWords } from './keyStatus';
import { agentWords } from '../components/StatusLine';
import type { Route } from './route';

export interface SidebarStatus {
  /** Line 1: "Idle", "Paused", or "Scanning · step 4 of 8". */
  state: string;
  /** The bar under line 1 while a scan runs. */
  running: boolean;
  /** Line 2: "Next scan 5:23 AM" or "Last scan 51 min ago"; null while a scan runs (line 1 says where it is). */
  when: string | null;
  /** Line 3: "119 searches left · Keepa 57 tokens"; short when fee lookups wait. */
  usage: string;
  /** Line 3 in full, for its tooltip. */
  usageFull: string;
  /** Line 4: the one thing wrong, with where to go; null when nothing is. */
  problem: { text: string; to: Route } | null;
}

const isRunning = (s: AppState): boolean => s.agent.status === 'scanning' || s.agent.status === 'asking' || s.agent.status === 'stopping';

/** "Step 4 of 8" from the agent's own count, or null. Nothing is counted here. */
function stepWords(s: AppState): string | null {
  const p = s.agent.pipeline;
  return p ? `step ${Math.min(p.stepsTotal, p.stepsDone + 1)} of ${p.stepsTotal}` : null;
}

export function sidebarStatus(state: AppState, now: number = Date.now()): SidebarStatus {
  const { agent, budget, helper } = state;
  const running = isRunning(state);
  const words = agentWords(agent, now);
  const step = running ? stepWords(state) : null;
  const head = step ? `${words.state} · ${step}` : words.state;

  let line2: string | null = null;
  if (!running) {
    if (agent.status === 'paused') line2 = 'No scheduled scan until you resume';
    else if (agent.nextScanAt) line2 = `Next scan ${when(agent.nextScanAt, now)}`;
    else if (agent.lastScan) line2 = `Last scan ${when(agent.lastScan.at, now)}`;
    else line2 = 'Scans when you press Scan now';
  }

  const searches = budget.serpLeft === null ? 'Searches not checked yet' : `${count(budget.serpLeft)} ${budget.serpLeft === 1 ? 'search' : 'searches'} left`;
  const keepa = keepaWords(state);
  // "Keepa 57 tokens · 1 a minute": the rate is in Today's Agent card.
  const keepaShort = keepa ? keepa.split(' · ')[0]! : null;
  // Fee lookups fold into this line (never a fifth). The sidebar is narrow, so with some waiting the line is short
  // ("119 searches · 24 fee lookups") and `usageFull` (the row's tooltip) says it all: "119 searches left · 24 fee lookups
  // waiting · Keepa 57 tokens · 1 a minute".
  const fees = feeLookupWords(agent.drip);
  // Key stacking: the totals stay on the line; the tooltip adds each key's share ("SerpApi Key 1 60 · Partner 143").
  const serpSplit = perKeySplit(state, 'serpapi');
  const keepaSplit = perKeySplit(state, 'keepa');
  const usageFull = [searches, fees, keepa ?? null, serpSplit ? `SerpApi ${serpSplit}` : null, keepaSplit ? `Keepa ${keepaSplit}` : null].filter((x): x is string => !!x).join(' · ');
  const usage = fees ? `${searches.replace(/ left$/, '')} · ${fees.replace(/ waiting$/, '')}` : keepaShort ? `${searches} · ${keepaShort}` : searches;

  let problem: SidebarStatus['problem'] = null;
  const rejected = rejectedKeysWords(state);
  if (rejected) problem = { text: rejected, to: { screen: 'settings', id: 'keys' } };
  else if (helper.paired && !helper.connected) problem = { text: 'Chrome closed', to: { screen: 'settings', id: 'chrome' } };
  else if (!helper.paired) problem = { text: 'Chrome not connected', to: { screen: 'settings', id: 'chrome' } };
  return { state: head, running, when: line2, usage, usageFull, problem };
}
