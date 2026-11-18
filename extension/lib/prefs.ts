// Settings and the SerpApi key, in chrome.storage.local. The key is returned only by
// getKey. It is never logged and never written anywhere else.

import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, KNOWN_BRANDS, type ExtensionSettings, type ScanTrigger } from '@core/settings';
import type { AccountInfo } from '@core/serpapi/budget';

export interface ActiveScan {
  jobId: string;
  trigger: ScanTrigger;
  /** Continuations in a row that found the job where the last one left it. */
  attempts?: number;
  /** The job's searchesUsed, phase and queue length when it was last started or continued. */
  progress?: string;
}

export interface StoredAccount {
  info: AccountInfo;
  at: number;
}

const local = () => browser.storage.local;

async function read(key: string): Promise<unknown> {
  return (await local().get(key))[key];
}

async function write(key: string, value: unknown): Promise<void> {
  await local().set({ [key]: value });
}

// ---------------------------------------------------------------- key

export async function getKey(): Promise<string | null> {
  const v = await read('apiKey');
  return typeof v === 'string' && v !== '' ? v : null;
}

export const setKey = (key: string): Promise<void> => write('apiKey', key);

export async function forgetKey(): Promise<void> {
  await local().remove('apiKey');
}

/** Keeps content scripts out of storage.local. Does nothing where the browser lacks the call. */
export async function restrictKeyAccess(): Promise<void> {
  const area = local() as unknown as { setAccessLevel?: (o: { accessLevel: string }) => Promise<void> };
  if (typeof area.setAccessLevel === 'function') await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

// ---------------------------------------------------------------- settings

const wholeIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const validBrands = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((b) => (KNOWN_BRANDS as readonly string[]).includes(b));

/** Defaults under whatever is stored, field by field; a wrong or out-of-range field takes its default. */
export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await read('settings');
  const s = (typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored : {}) as Record<string, unknown>;
  const d = structuredClone(DEFAULT_SETTINGS);
  return {
    ...d,
    ...Object.fromEntries(Object.entries(s).filter(([k]) => k in d && k !== 'searchesPerScan' && k !== 'reserve' && k !== 'pagesPerBrand' && k !== 'brands')),
    searchesPerScan: wholeIn(s.searchesPerScan, 1, 250) ? s.searchesPerScan : d.searchesPerScan,
    reserve: wholeIn(s.reserve, 0, 250) ? s.reserve : d.reserve,
    pagesPerBrand: wholeIn(s.pagesPerBrand, 1, 5) ? s.pagesPerBrand : d.pagesPerBrand,
    brands: validBrands(s.brands) ? [...s.brands] : d.brands,
  };
}

export const saveSettings = (s: ExtensionSettings): Promise<void> => write('settings', s);

// ---------------------------------------------------------------- chip

/**
 * Whether the chip shows on Home Depot product pages. Default true; only an explicit false turns it off.
 * It lives in storage.sync, not storage.local: the worker closes storage.local to content scripts
 * (restrictKeyAccess, so the SerpApi key stays out of reach), and the content script on a Home Depot
 * page has to read this. It is one non-secret boolean; the key never goes near it.
 */
export async function getShowChip(): Promise<boolean> {
  return (await browser.storage.sync.get('showChip')).showChip !== false;
}
export const setShowChip = (on: boolean): Promise<void> => browser.storage.sync.set({ showChip: on });

// ---------------------------------------------------------------- packaging

/** The owner's packaging answers by upper-case bundle model. An entry that is not a known answer is dropped. */
export async function getPackaging(): Promise<Record<string, 'retail_boxed' | 'loose'>> {
  const v = await read('packaging');
  const out: Record<string, 'retail_boxed' | 'loose'> = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [model, answer] of Object.entries(v)) if (answer === 'retail_boxed' || answer === 'loose') out[model] = answer;
  return out;
}
export const savePackaging = (v: Record<string, 'retail_boxed' | 'loose'>): Promise<void> => write('packaging', v);

// ---------------------------------------------------------------- the rest

export async function getActiveScan(): Promise<ActiveScan | null> {
  const v = await read('activeScan');
  return typeof v === 'object' && v !== null ? (v as ActiveScan) : null;
}
export const setActiveScan = (v: ActiveScan | null): Promise<void> => write('activeScan', v);

export async function getLastScheduledRunAt(): Promise<number | null> {
  const v = await read('lastScheduledRunAt');
  return typeof v === 'number' ? v : null;
}
export const setLastScheduledRunAt = (v: number | null): Promise<void> => write('lastScheduledRunAt', v);

export async function getNotified(): Promise<string[]> {
  const v = await read('notified');
  return Array.isArray(v) ? (v as string[]) : [];
}
export const setNotified = (v: string[]): Promise<void> => write('notified', v);

export async function getAccount(): Promise<StoredAccount | null> {
  const v = await read('account');
  return typeof v === 'object' && v !== null ? (v as StoredAccount) : null;
}
export const setAccount = (v: StoredAccount | null): Promise<void> => write('account', v);
