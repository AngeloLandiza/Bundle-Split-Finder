// The command palette's contents and ranking (Cmd+K). Pure: the screen builds the lists from what the agent said
// and this module orders them. Nothing here runs a command; it names it, and the palette runs it.

import type { AppState, DealRow, ReviewQuestion } from '../api/types';
import { KIND_LABEL } from '../screens/reviewModel';
import { plural } from './format';
import { scanSpend } from './scanSpend';
import { modLabel, SCREENS, type Screen } from './keys';
import { wordsFor } from './platform';
import { PREF_TABS, TAB_LABEL, type PrefTab } from './prefs';
import type { Route } from './route';
import { BOUGHT_LABEL, BOUGHT_VIEW, DEAL_VIEWS, VIEW_LABEL } from './views';

export type PaletteSection = 'Go to' | 'Actions' | 'Deals' | 'Questions';
export const PALETTE_SECTIONS: readonly PaletteSection[] = ['Go to', 'Actions', 'Deals', 'Questions'];

export type CommandId = 'scan' | 'stop' | 'pause' | 'resume' | 'ask-all' | 'approve-all' | 'csv' | 'watch' | 'unwatch';

export type PaletteAction =
  | { type: 'go'; route: Route }
  | { type: 'preferences'; tab: PrefTab }
  | { type: 'command'; command: CommandId; dealId?: string }
  | { type: 'deal'; id: string }
  | { type: 'question'; id: string };

export interface PaletteItem {
  id: string;
  section: PaletteSection;
  title: string;
  /** A muted second line or tail: the brand and model of a deal, the kind of a question. */
  detail?: string;
  /** Shown at the right: a shortcut, or a cost ("5 searches"). */
  hint?: string;
  /** Words the title does not hold but a search may use: a model, an item number. */
  keywords?: string;
  action: PaletteAction;
  /** A command that changes answers asks first: the sentence it asks. */
  confirm?: string;
}

const SCREEN_LABEL: Record<Screen, string> = { today: 'Today', deals: 'Deals', review: 'Review', activity: 'Activity', settings: 'Preferences', costs: 'Costs' };

/** Where the palette goes: the screens, each Deals view, and each pane of the Preferences window (which opens at that pane). */
export function goToItems(mac: boolean, windows = !mac): PaletteItem[] {
  const prefs = wordsFor(windows).preferences;
  const out: PaletteItem[] = [];
  SCREENS.forEach((screen, i) => {
    out.push({
      id: `go:${screen}`,
      section: 'Go to',
      title: screen === 'settings' ? prefs : SCREEN_LABEL[screen],
      hint: modLabel(String(i + 1), mac),
      ...(screen === 'costs' ? { keywords: 'what it costs budget spend spending limit forecast searches tokens ai dollars' } : {}),
      action: screen === 'settings' ? { type: 'preferences', tab: 'general' } : { type: 'go', route: { screen, id: null } },
    });
    if (screen === 'deals') {
      for (const v of DEAL_VIEWS) {
        if (v === 'all') continue;
        out.push({ id: `go:deals:${v}`, section: 'Go to', title: `Deals · ${VIEW_LABEL[v]}`, keywords: `${VIEW_LABEL[v]} view`, action: { type: 'go', route: { screen: 'deals', id: null, view: v } } });
      }
      out.push({ id: `go:deals:${BOUGHT_VIEW}`, section: 'Go to', title: `Deals · ${BOUGHT_LABEL}`, keywords: 'bought purchases outcomes sold', action: { type: 'go', route: { screen: 'deals', id: null, view: BOUGHT_VIEW } } });
    }
  });
  for (const tab of PREF_TABS) {
    if (tab === 'general') continue;
    out.push({ id: `pref:${tab}`, section: 'Go to', title: `${prefs} · ${TAB_LABEL[tab]}`, keywords: `preferences settings ${TAB_LABEL[tab]}`, action: { type: 'preferences', tab } });
  }
  return out;
}

export interface ActionContext {
  state: AppState | null;
  /** Open questions the AI has not been asked about, with a price on the call. */
  askable: number;
  /** Open questions whose suggestion the code verified. */
  verified: number;
  /** Deals the agent holds (a CSV needs one). */
  deals: number;
  /** The deal open in the inspector, so Watch and Unwatch can name it; null when none is open. */
  deal?: { id: string; model: string; watched: boolean } | null;
}

/** The commands he may run now. A command that cannot run is left out, not greyed: the list is short and honest. */
export function actionItems(c: ActionContext): PaletteItem[] {
  const s = c.state;
  if (!s) return [];
  const status = s.agent.status;
  const running = status === 'scanning' || status === 'asking';
  const busy = status !== 'idle' && status !== 'error' && status !== 'paused';
  const out: PaletteItem[] = [];
  const act = (id: CommandId, title: string, extra: Partial<PaletteItem> = {}) => out.push({ id: `cmd:${id}`, section: 'Actions', title, action: { type: 'command', command: id }, ...extra });
  if (running) act('stop', 'Stop', { keywords: 'cancel scan' });
  if (!busy && s.keys.serpapi) {
    act('scan', 'Scan now', { hint: scanSpend(s.budget).cost, keywords: 'run find deals' });
  }
  if (status === 'paused') act('resume', 'Resume agent', { keywords: 'unpause' });
  else act('pause', 'Pause agent', { keywords: 'hold' });
  if (c.askable >= 1 && (s.keys.anthropic || s.keys.openai) && !busy) act('ask-all', `Ask AI about all ${c.askable}`, { keywords: 'questions review' });
  if (c.verified >= 1) {
    act('approve-all', `Approve all ${c.verified} verified`, {
      keywords: 'answers ai review',
      confirm: `Approve ${plural(c.verified, 'verified AI answer', 'verified AI answers')}? Each is applied as your answer.`,
    });
  }
  if (c.deal) {
    const d = c.deal;
    out.push({
      id: `cmd:${d.watched ? 'unwatch' : 'watch'}`,
      section: 'Actions',
      title: `${d.watched ? 'Unwatch' : 'Watch'} ${d.model}`,
      keywords: 'watchlist track deal',
      action: { type: 'command', command: d.watched ? 'unwatch' : 'watch', dealId: d.id },
    });
  }
  if (c.deals > 0) act('csv', 'Download CSV', { keywords: 'export deals' });
  return out;
}

export function dealItems(rows: readonly DealRow[]): PaletteItem[] {
  return rows.map((r) => ({
    id: `deal:${r.id}`,
    section: 'Deals' as const,
    title: r.title,
    detail: `${r.brand} · ${r.model}`,
    keywords: [r.model, r.brand, r.itemId ?? '', r.id].join(' '),
    action: { type: 'deal' as const, id: r.id },
  }));
}

export function questionItems(questions: readonly ReviewQuestion[]): PaletteItem[] {
  return questions.map((q) => ({
    id: `question:${q.id}`,
    section: 'Questions' as const,
    title: q.bundle.title,
    detail: `${KIND_LABEL[q.kind]} · ${q.subject}`,
    keywords: [q.subject, q.bundle.model, q.prompt].join(' '),
    action: { type: 'question' as const, id: q.id },
  }));
}

// ---------------------------------------------------------------- ranking

const norm = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * How well one word of the query fits a text, or null. A whole-word match beats a word's start, which beats the
 * middle of a word, which beats letters in order (a fuzzy match, "pcl2k" for "PCL2200K3N"); earlier is better.
 */
export function wordScore(word: string, text: string): number | null {
  if (word === '') return 0;
  const at = text.indexOf(word);
  if (at >= 0) {
    const before = at === 0 ? ' ' : text[at - 1]!;
    const boundary = !/[a-z0-9]/.test(before);
    const end = at + word.length;
    const whole = boundary && (end === text.length || !/[a-z0-9]/.test(text[end]!));
    return (whole ? 100 : boundary ? 80 : 50) - Math.min(at, 30) / 3;
  }
  // Letters in order, a few letters skipped at most ("pc2200" for "pcl2200k3n"), so a stray letter across a long title is not a match.
  let from = 0;
  let last = -1;
  let gaps = 0;
  for (const ch of word) {
    const i = text.indexOf(ch, from);
    if (i < 0 || (last >= 0 && i - last > 3)) return null;
    gaps += last >= 0 ? i - last - 1 : 0;
    last = i;
    from = i + 1;
  }
  return Math.max(5, 30 - gaps);
}

/** The query's words must each fit the title (weighted) or the other words; null when one does not fit anywhere. */
export function itemScore(query: string, item: Pick<PaletteItem, 'title' | 'detail' | 'keywords'>): number | null {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const title = norm(item.title);
  const rest = norm(`${item.detail ?? ''} ${item.keywords ?? ''}`);
  let total = 0;
  for (const w of words) {
    const inTitle = wordScore(w, title);
    const inRest = wordScore(w, rest);
    const best = Math.max(inTitle !== null ? inTitle * 1.2 : -1, inRest ?? -1);
    if (best < 0) return null;
    total += best;
  }
  return total;
}

const CAPS: Record<PaletteSection, number> = { 'Go to': 8, Actions: 8, Deals: 8, Questions: 5 };

export interface PaletteGroup {
  section: PaletteSection;
  items: PaletteItem[];
}

/**
 * The palette's list. With nothing typed: Go to and Actions, in their own order. With a query: every section by score
 * (ties keep the given order), Deals and Questions included, capped so a long list does not bury the rest.
 */
export function rank(items: readonly PaletteItem[], query: string): PaletteGroup[] {
  const q = query.trim();
  const groups: PaletteGroup[] = [];
  for (const section of PALETTE_SECTIONS) {
    const own = items.filter((i) => i.section === section);
    if (q === '') {
      if (section === 'Deals' || section === 'Questions') continue;
      // The Preferences panes wait for a word ("fees", "keys"): the quiet list is the screens and the Deals views.
      const quiet = own.filter((i) => !i.id.startsWith('pref:'));
      if (quiet.length) groups.push({ section, items: quiet });
      continue;
    }
    const scored: { item: PaletteItem; score: number; at: number }[] = [];
    own.forEach((item, at) => {
      const score = itemScore(q, item);
      if (score !== null) scored.push({ item, score, at });
    });
    scored.sort((a, b) => b.score - a.score || a.at - b.at);
    if (scored.length) groups.push({ section, items: scored.slice(0, CAPS[section]).map((s) => s.item) });
  }
  return groups;
}

/** The groups as one list, in the order the arrow keys walk them. */
export const flatten = (groups: readonly PaletteGroup[]): PaletteItem[] => groups.flatMap((g) => g.items);
