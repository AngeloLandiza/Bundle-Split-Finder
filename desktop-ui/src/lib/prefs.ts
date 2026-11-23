// The Preferences window's pure parts: its tabs and their addresses, the checks a field makes before it
// saves, the rule that keeps one way back into the app, and how a look maps to the agent's appearance
// setting. The window itself is screens/preferences/.

import type { Accent, Appearance, Density, Look } from './appearance';
import type { GlyphName } from '../components/Glyph';

export const PREF_TABS = ['general', 'scanning', 'keys', 'ai', 'notifications', 'chrome', 'data', 'advanced'] as const;
export type PrefTab = (typeof PREF_TABS)[number];

export const TAB_LABEL: Record<PrefTab, string> = {
  general: 'General',
  scanning: 'Scanning',
  keys: 'Keys',
  ai: 'AI',
  notifications: 'Notifications',
  chrome: 'Chrome',
  data: 'Data',
  advanced: 'Advanced',
};

export const TAB_GLYPH: Record<PrefTab, GlyphName> = {
  general: 'gear',
  scanning: 'scan',
  keys: 'key',
  ai: 'sparkle',
  notifications: 'bell',
  chrome: 'globe',
  data: 'drive',
  advanced: 'options',
};

export const DEFAULT_TAB: PrefTab = 'general';

/** Whether an address is the Preferences window's: `#/preferences` or `#/preferences/<tab>`. */
export function isPreferencesHash(hash: string): boolean {
  return /^#?\/?preferences(\/|$)/.test(hash);
}

/** The tab an address names; General for none or an unknown one. */
export function parsePrefsTab(hash: string): PrefTab {
  const m = /^#?\/?preferences\/([a-z]+)/.exec(hash);
  return PREF_TABS.find((t) => t === m?.[1]) ?? DEFAULT_TAB;
}

export const prefsHash = (tab: PrefTab): string => `#/preferences/${tab}`;

/** The tab a link from the old Settings screen (`#/settings/<section>`) lands on. */
export function tabForSettingsId(id: string | null): PrefTab {
  switch (id) {
    case 'scanning':
    case 'fees':
    case 'brands':
      return 'scanning';
    case 'keys':
      return 'keys';
    case 'ai':
      return 'ai';
    case 'alerts':
      return 'notifications';
    case 'chrome':
      return 'chrome';
    default:
      return DEFAULT_TAB;
  }
}

/** Left and right arrows (and Home and End) move between the tabs; null for any other key. */
export function nextTab(current: PrefTab, key: string): PrefTab | null {
  const i = PREF_TABS.indexOf(current);
  if (key === 'ArrowRight') return PREF_TABS[(i + 1) % PREF_TABS.length]!;
  if (key === 'ArrowLeft') return PREF_TABS[(i + PREF_TABS.length - 1) % PREF_TABS.length]!;
  if (key === 'Home') return PREF_TABS[0]!;
  if (key === 'End') return PREF_TABS[PREF_TABS.length - 1]!;
  return null;
}

// ---------------------------------------------------------------- number fields

export interface NumberRule {
  min: number;
  max?: number;
  whole?: boolean;
  /** What the field is, for the sentence: "Searches per scan". */
  what: string;
  /** "$" or "%", so the sentence reads as the field does. */
  unit?: '$' | '%';
}

export type Checked = { ok: true; value: number } | { ok: false; message: string };

const range = (r: NumberRule): string => {
  const unit = (n: number) => (r.unit === '$' ? `$${n}` : r.unit === '%' ? `${n}%` : String(n));
  if (r.max === undefined) return `${r.whole ? 'a whole number' : 'a number'} of ${unit(r.min)} or more`;
  return `${r.whole ? 'a whole number' : 'a number'} from ${unit(r.min)} to ${unit(r.max)}`;
};

/** A typed number checked against its rule. Empty, text and out-of-range values say what to use instead. */
export function checkNumber(text: string, rule: NumberRule): Checked {
  const t = text.trim().replace(/,/g, '');
  const n = Number(t);
  const fail = (): Checked => ({ ok: false, message: `${rule.what}: use ${range(rule)}.` });
  if (t === '' || !Number.isFinite(n)) return fail();
  if (rule.whole && !Number.isInteger(n)) return fail();
  if (n < rule.min || (rule.max !== undefined && n > rule.max)) return fail();
  return { ok: true, value: n };
}

/** The same limits the agent enforces (core/src/settings.ts validateSettings), so a refusal is rare. */
export const RULES = {
  searchesPerScan: { min: 1, max: 250, whole: true, what: 'Searches per scan' },
  reserve: { min: 0, max: 250, whole: true, what: 'Reserve' },
  scheduleHours: { min: 1, max: 168, whole: true, what: 'Hours between scans' },
  keepaTokensPerScan: { min: 0, max: 250, whole: true, what: 'Keepa tokens per scan' },
  keepaReserve: { min: 0, max: 250, whole: true, what: 'Keepa reserve' },
  referralPercent: { min: 0, max: 100, what: 'Referral fee', unit: '%' },
  minReferral: { min: 0, what: 'Minimum referral', unit: '$' },
  fulfillmentFee: { min: 0, what: 'Fulfillment', unit: '$' },
  salesTaxPercent: { min: 0, what: 'Sales tax', unit: '%' },
  inboundCost: { min: 0, what: 'Inbound cost', unit: '$' },
  minRoiPercent: { min: 0, what: 'ROI', unit: '%' },
  minProfit: { min: 0, what: 'Estimated profit', unit: '$' },
  minMonthlySold: { min: 0, max: 1_000_000, whole: true, what: 'Sold a month' },
  floorProfit: { min: -100_000, what: 'Profit floor', unit: '$' },
  monthlyCapUsd: { min: 0, what: 'Monthly AI cap', unit: '$' },
} satisfies Record<string, NumberRule>;

/** "07:30" style, 24 hours: what the agent accepts. */
export const isClock = (v: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** A model's address: https, or http on this Mac; anything else would send a key somewhere unsafe. */
export function checkBaseUrl(text: string): { ok: true; value: string } | { ok: false; message: string } {
  const t = text.trim();
  try {
    const u = new URL(t);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return { ok: true, value: t.replace(/\/+$/, '') };
  } catch {
    // the sentence below
  }
  return { ok: false, message: 'Use a web address that starts with https://, such as https://api.deepseek.com.' };
}

// ---------------------------------------------------------------- the way back in

export interface ShellFlags {
  menuBarIcon: boolean;
  dockIcon: boolean;
}

/**
 * With the Dock icon and the menu bar icon both off there is no way back into the app. A switch that
 * would be the last one turned off is refused: `blocked` names it, and the sentence says why.
 */
export function guardIcons(cur: ShellFlags, patch: Partial<ShellFlags>): { next: ShellFlags; blocked: keyof ShellFlags | null } {
  const next = { ...cur, ...patch };
  if (!next.menuBarIcon && !next.dockIcon) {
    // Keep the one that was on before, refuse the one just turned off.
    const blocked: keyof ShellFlags = patch.menuBarIcon === false ? 'menuBarIcon' : 'dockIcon';
    return { next: cur, blocked };
  }
  return { next, blocked: null };
}

export const ICON_GUARD_SENTENCE = 'Keep at least one of the two on. With both off there is no way back into the app.';

/** Whether a switch is the last of the two that is on, so it cannot be turned off. */
export const isLastIcon = (cur: ShellFlags, key: keyof ShellFlags): boolean => cur[key] && !(key === 'menuBarIcon' ? cur.dockIcon : cur.menuBarIcon);

// ---------------------------------------------------------------- the look and the agent

export interface AppearanceSetting {
  theme: Appearance;
  accent: Accent;
  density: Density;
}

/** The agent keeps the look under its own names ("theme"); the window keeps it in `Look`. */
export const toAppearanceSetting = (look: Look): AppearanceSetting => ({ theme: look.appearance, accent: look.accent, density: look.density });
export const fromAppearanceSetting = (a: AppearanceSetting): Look => ({ appearance: a.theme, accent: a.accent, density: a.density });

// ---------------------------------------------------------------- the pane's height

/** The window height for a toolbar and a pane, kept inside the window's limits (src-tauri prefs.rs). */
export function windowHeight(barPx: number, paneContentPx: number): number {
  return Math.round(Math.max(320, Math.min(820, barPx + paneContentPx)));
}

/** Shown under Fulfillment while it is $0: an estimate that leaves out a cost says so (docs/ux-checklist.md, item 4). */
export const FBA_AT_ZERO = 'At $0 the estimate leaves out Amazon’s fulfillment fee. Keepa’s FBA estimate, when available, shows beside each deal.';
