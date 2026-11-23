import { checkEbayKeys, type TokenStore } from '../extension/lib/ebayEnv';

const noopStore: TokenStore = {
  get: async () => null,
  set: async () => {},
  clear: async () => {},
};

export type EbayKeyCheck = { ok: true } | { ok: false; message: string };

/** Live token request to eBay (free). Never log secrets. */
export async function checkEbayKeysApp(appId: string, certId: string): Promise<EbayKeyCheck> {
  const a = appId.trim();
  const c = certId.trim();
  if (!a || !c) return { ok: false, message: 'Enter both eBay App ID and Cert ID.' };
  const problem = await checkEbayKeys({ appId: a, certId: c, fetchFn: fetch, store: noopStore, now: () => Date.now() });
  return problem ? { ok: false, message: problem } : { ok: true };
}