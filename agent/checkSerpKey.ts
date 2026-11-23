import type { AccountInfo } from '../core/src/serpapi/budget';
import { SerpApiClient } from '../core/src/serpapi/client';

export type SerpKeyCheck =
  | { ok: true; account: AccountInfo }
  | { ok: false; message: string };

/** Account API is free (docs/search-budget.md). Never log the key. */
export async function checkSerpApiKey(apiKey: string, fetchFn: typeof fetch = fetch): Promise<SerpKeyCheck> {
  const key = apiKey.trim();
  if (!key) return { ok: false, message: 'Enter your SerpApi key.' };
  try {
    const account = await SerpApiClient.account(key, fetchFn);
    return { ok: true, account };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not check this key.';
    return { ok: false, message: msg };
  }
}