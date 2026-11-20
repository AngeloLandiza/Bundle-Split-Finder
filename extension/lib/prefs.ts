// Settings and the SerpApi key, in chrome.storage.local. The key is returned only by
// getKey. It is never logged and never written anywhere else.

import { browser } from 'wxt/browser';
import { DEFAULT_EBAY_SETTINGS, DEFAULT_SETTINGS, KNOWN_BRANDS, type EbaySettings, type ExtensionSettings, type ScanTrigger } from '@core/settings';
import { CLAUDE_JUDGE_MODELS } from '@core/judge/claude';
import { MAX_LISTINGS_JUDGED_PER_SCAN } from '@core/scan/ebayPass';
import { trustedRates, type UnitRates } from '@core/scan/pipeline';
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
 * In storage.local with the other prefs: a content script cannot read it (restrictKeyAccess), so the worker
 * answers the chip's pageSeen with `off` and tells open Home Depot tabs when the owner changes it.
 */
export async function getShowChip(): Promise<boolean> {
  return (await read('showChip')) !== false;
}
export const setShowChip = (on: boolean): Promise<void> => write('showChip', on);

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

// ---------------------------------------------------------------- scan timing (step 11)

/**
 * How long a unit of each kind took in the last scans (searches, Home Depot page reads, eBay calls, model calls by model):
 * the last 20 measured seconds-per-unit of each, which the progress estimate takes the median of. Not a secret and not a
 * setting: it only makes the estimate better. Read untrusted: whatever is not a list of positive numbers is dropped.
 */
export async function getRates(): Promise<UnitRates> {
  return trustedRates(await read('unitRates'));
}
export const setRates = (v: UnitRates): Promise<void> => write('unitRates', trustedRates(v));

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

// ---------------------------------------------------------------- eBay and the model (step 10)

// The eBay App ID and Cert ID and the Anthropic key are secrets like the SerpApi key: chrome.storage.local only
// (restrictKeyAccess keeps content scripts out), returned only by these functions, never logged, sent only to
// api.ebay.com and api.anthropic.com. The judge model and the listings judged per scan are not secrets.

export interface EbayKeys {
  appId: string;
  certId: string;
}

export async function getEbayKeys(): Promise<EbayKeys | null> {
  const v = await read('ebayKeys');
  if (typeof v !== 'object' || v === null) return null;
  const { appId, certId } = v as Record<string, unknown>;
  return typeof appId === 'string' && appId !== '' && typeof certId === 'string' && certId !== '' ? { appId, certId } : null;
}
export const setEbayKeys = (keys: EbayKeys): Promise<void> => write('ebayKeys', { appId: keys.appId, certId: keys.certId });
export async function forgetEbayKeys(): Promise<void> {
  await local().remove('ebayKeys');
}

export async function getAnthropicKey(): Promise<string | null> {
  const v = await read('anthropicKey');
  return typeof v === 'string' && v !== '' ? v : null;
}
export const setAnthropicKey = (key: string): Promise<void> => write('anthropicKey', key);
export async function forgetAnthropicKey(): Promise<void> {
  await local().remove('anthropicKey');
}

const knownModel = (v: unknown): v is string => typeof v === 'string' && (CLAUDE_JUDGE_MODELS as readonly string[]).includes(v);

/** Defaults under whatever is stored, field by field. */
export async function getEbaySettings(): Promise<EbaySettings> {
  const v = await read('ebaySettings');
  const s = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return {
    judgeModel: knownModel(s.judgeModel) ? s.judgeModel : DEFAULT_EBAY_SETTINGS.judgeModel,
    listingsJudgedPerScan: wholeIn(s.listingsJudgedPerScan, 1, MAX_LISTINGS_JUDGED_PER_SCAN) ? s.listingsJudgedPerScan : DEFAULT_EBAY_SETTINGS.listingsJudgedPerScan,
  };
}
export const saveEbaySettings = (s: EbaySettings): Promise<void> => write('ebaySettings', { judgeModel: s.judgeModel, listingsJudgedPerScan: s.listingsJudgedPerScan });

// ---------------------------------------------------------------- eBay's access token (storage.session)

/**
 * eBay's application token is valid two hours, and the grant is limited to 1,000 a day: it is kept in storage.session,
 * which outlives the service worker and is gone when the browser closes. Bound to the App ID it was granted for.
 */
export interface CachedEbayToken {
  appId: string;
  token: string;
  expiresAt: number;
}

export async function getEbayToken(): Promise<CachedEbayToken | null> {
  const v = (await browser.storage.session.get('ebayToken')).ebayToken as unknown;
  if (typeof v !== 'object' || v === null) return null;
  const { appId, token, expiresAt } = v as Record<string, unknown>;
  return typeof appId === 'string' && typeof token === 'string' && token !== '' && typeof expiresAt === 'number' ? { appId, token, expiresAt } : null;
}
export const setEbayToken = (t: CachedEbayToken): Promise<void> => browser.storage.session.set({ ebayToken: t });
export async function clearEbayToken(): Promise<void> {
  await browser.storage.session.remove('ebayToken');
}
