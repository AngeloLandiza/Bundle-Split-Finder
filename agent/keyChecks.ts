// Nov 23: every key is checked with its own service the moment it is saved, and again on demand from the stored value
// (Settings, Keys). A wrong eBay pair once sat saved for two scans before anyone knew.
//
// Which request checks which service, and what it costs. All of them are free: nothing here makes a model write text, and
// nothing searches.
//   SerpApi      GET serpapi.com/account.json            free (the account API is not a search)       -> plan and searches left
//   Keepa        GET api.keepa.com/token                 free (the token status consumes no tokens)   -> tokens left, refill a minute
//   eBay         POST api.ebay.com/.../oauth2/token      free (client credentials, 1,000 a day)        -> ok, or eBay's own words
//   Anthropic    GET api.anthropic.com/v1/models         free (lists models; no tokens are generated)  -> ok, or the error type
//   OpenAI-like  GET {address}/models                    free (a list, no completion)                  -> ok, or the service's words
//   Telegram     GET api.telegram.org/bot<t>/getMe, then /getChat (free; no message is sent)           -> the bot's name
// A message to Telegram goes only from the explicit Test button (POST /api/notify/test-telegram).
//
// Rule 3: a key is sent only to its own service, never put in a sentence, a log or an answer. Every sentence that leaves this
// file goes through `scrubKeyText`, which takes every stored key (and the Basic credential made of the eBay pair) out BEFORE the
// text is cut, so a key that straddles the cut cannot stay in part (security review, Nov 23: I1 and M10). A fetch error's own
// text is never used: it can carry the address, and the address can carry the key.
//
// A network failure or a service outage is not a rejected key: those answers say "could not check", and the key's recorded
// state is left as it was.

import {
  KEY_NAMES,
  type KeyCheck,
  type KeyCheckRecord,
  type KeyName,
} from '../core/src/api/contract';
import { OPENAI_COMPATIBLE_PRESETS } from '../core/src/ai/openai';
import type { PipelineAiSettings } from '../core/src/ai/factory';
import { EbayAuthError, EbayClient, EbayError, EbayRateLimitedError, EbayServerError } from '../core/src/ebay/client';
import { ANTHROPIC_VERSION } from '../core/src/judge/claude';
import { KeepaClient, KeepaError, KeepaRateLimitedError } from '../core/src/keepa/client';
import { TokenBudget } from '../core/src/keepa/budget';
import { NETWORK_ERROR_PREFIX, SerpApiClient, SerpApiError } from '../core/src/serpapi/client';
import { telegramProblemWords } from './alerts';
import type { Store, StoredKeys } from './store';

/** How long one check may take before it is called "could not reach". */
export const KEY_CHECK_TIMEOUT_MS = 10_000;
/** A saved key with no verdict newer than this is checked again, quietly. */
export const KEY_RECHECK_MS = 24 * 3_600_000;

// ---------------------------------------------------------------- the one scrubber

const b64 = (s: string): string => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s).toString('base64'));
const b64url = (s: string): string => b64(s).replace(/\+/g, '-').replace(/\//g, '_');

/**
 * Everything that must never appear in a sentence: each stored key as it is, URL-encoded, and (eBay) the Basic credential
 * `base64(appId:certId)` in its padded, unpadded and URL-safe forms; Telegram's secret half after the colon too. Longest first,
 * so a longer form is taken out whole before a shorter one inside it could split it.
 */
export function keySecrets(keys: StoredKeys): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined): void => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (t.length < 4) return;
    out.add(t);
    out.add(encodeURIComponent(t));
  };
  add(keys.serpapi);
  add(keys.keepa);
  add(keys.anthropic);
  add(keys.openai);
  add(keys.ebay?.appId);
  add(keys.ebay?.certId);
  add(keys.telegram?.botToken);
  const token = keys.telegram?.botToken.trim();
  if (token && token.includes(':')) add(token.slice(token.indexOf(':') + 1));
  const e = keys.ebay;
  if (e && e.appId.trim() && e.certId.trim()) {
    const basic = `${e.appId.trim()}:${e.certId.trim()}`;
    for (const form of [b64(basic), b64url(basic)]) {
      out.add(form);
      out.add(form.replace(/=+$/, ''));
    }
  }
  return [...out].sort((a, z) => z.length - a.length);
}

/**
 * Text for the owner: control characters to spaces, every key (see keySecrets) replaced by "[key]", and only then cut to `max`
 * characters. Never throws.
 */
export function scrubKeyText(text: string, keys: StoredKeys, max = 300): string {
  let t = String(text).replace(/[\u0000-\u001f\u007f]/g, ' ');
  for (const secret of keySecrets(keys)) t = t.split(secret).join('[key]');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------- shared pieces

export interface KeyCheckDeps {
  fetchFn: typeof fetch;
  /** The pipelines' settings: an OpenAI-compatible key is checked against the address a pipeline names. */
  ai?: Partial<Record<'judge' | 'assist' | 'research' | 'brief', PipelineAiSettings | undefined>>;
  /** Tests: SerpApi's address. */
  serpBaseUrl?: string;
  /** Default KEY_CHECK_TIMEOUT_MS. */
  timeoutMs?: number;
}

type Fail = Extract<KeyCheck, { ok: false }>;
type Kind = Fail['kind'];

/** A fetch that gives up when `signal` fires. */
const withSignal = (fetchFn: typeof fetch, signal: AbortSignal): typeof fetch => (input, init) => fetchFn(input, { ...init, signal });

/** What a service said, as `type: message` (or either), from the usual error body shapes. Not yet scrubbed. */
function saidIn(body: unknown): string {
  const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!rec(body)) return '';
  const e = rec(body.error) ? body.error : body;
  const type = typeof e.type === 'string' ? e.type : typeof e.code === 'string' ? e.code : typeof body.error === 'string' ? body.error : '';
  const message = typeof e.message === 'string' ? e.message : typeof e.error_description === 'string' ? e.error_description : typeof body.description === 'string' ? body.description : '';
  return type && message ? `${type}: ${message}` : type || message;
}

/** The kind for an HTTP status a service answered with: 401 and 403 are the key's; 429 is a limit; 5xx is the service's. */
function kindOf(status: number): Kind {
  if (status === 401 || status === 403) return 'rejected';
  if (status === 429) return 'limit';
  return 'service';
}

const DOWN = ', so it could not be checked just now';

// ---------------------------------------------------------------- one check per service

async function checkSerpApi(key: string, ctx: Ctx): Promise<KeyCheck> {
  try {
    const a = await SerpApiClient.account(key, ctx.fetchFn, ctx.serpBaseUrl);
    return { ok: true, detail: `${a.totalSearchesLeft} of ${a.searchesPerMonth} searches left` };
  } catch (err) {
    const status = err instanceof SerpApiError ? err.status : undefined;
    const message = err instanceof Error ? err.message : '';
    if (status === 401 || status === 403) return ctx.fail('rejected', `SerpApi did not accept this key (HTTP ${status}). Copy it again from serpapi.com › Manage API Key.`);
    if (status === 429) return ctx.fail('limit', `SerpApi is limiting calls (HTTP 429)${DOWN}`);
    if (status !== undefined) return ctx.fail('service', `SerpApi had a problem (HTTP ${status})${DOWN}`);
    if (message.startsWith(NETWORK_ERROR_PREFIX)) return ctx.fail('network', 'Could not reach SerpApi to check it just now');
    // A 200 whose body is an error ("Invalid API key"): SerpApi's words, when they are about the key.
    if (/api key/i.test(message)) return ctx.fail('rejected', `${message.replace(/^SerpApi account error:\s*/, 'SerpApi answered: ')}. Copy the key again from serpapi.com › Manage API Key.`);
    return ctx.fail('service', `SerpApi sent an answer this app could not read${DOWN}`);
  }
}

async function checkKeepa(key: string, ctx: Ctx): Promise<KeyCheck> {
  try {
    const client = new KeepaClient({ apiKey: key, budget: new TokenBudget({ reserve: 0, maxPerRun: Number.POSITIVE_INFINITY }), fetchFn: ctx.fetchFn, ...(ctx.keepaBaseUrl ? { baseUrl: ctx.keepaBaseUrl } : {}) });
    const s = await client.tokenStatus();
    const tokens = `${s.tokensLeft} ${s.tokensLeft === 1 ? 'token' : 'tokens'}`;
    return { ok: true, detail: s.refillRate > 0 ? `${tokens}, ${s.refillRate} a minute` : tokens };
  } catch (err) {
    const status = err instanceof KeepaError ? err.status : undefined;
    const message = err instanceof Error ? err.message : '';
    if (err instanceof KeepaRateLimitedError || status === 429) return ctx.fail('limit', `Keepa is limiting calls (HTTP 429)${DOWN}`);
    if (status === 401 || status === 403) return ctx.fail('rejected', `Keepa did not accept this key (HTTP ${status}). Copy the access key from keepa.com › Account › API access.`);
    if (status !== undefined) return ctx.fail('service', `Keepa had a problem (HTTP ${status})${DOWN}`);
    if (message.startsWith('Network error reaching Keepa')) return ctx.fail('network', 'Could not reach Keepa to check it just now');
    // An answer with an error object and no HTTP failure (Keepa's own words), when it is about the key.
    if (/key|access/i.test(message)) return ctx.fail('rejected', `Keepa answered: ${message}. Copy the access key from keepa.com › Account › API access.`);
    return ctx.fail('service', `Keepa sent an answer this app could not read${DOWN}`);
  }
}

async function checkEbay(pair: { appId: string; certId: string }, ctx: Ctx): Promise<KeyCheck> {
  try {
    await new EbayClient({ appId: pair.appId, certId: pair.certId, fetchFn: ctx.fetchFn, maxSearches: 0, maxItemReads: 0 }).verifyKeys();
    return { ok: true };
  } catch (err) {
    if (err instanceof EbayAuthError) {
      return ctx.fail('rejected', `${err.detail} Copy the App ID (Client ID) and Cert ID (Client Secret) from the Production keyset at developer.ebay.com › Application Keys.`);
    }
    if (err instanceof EbayRateLimitedError) return ctx.fail('limit', `eBay is limiting calls (HTTP 429)${DOWN}`);
    if (err instanceof EbayServerError) return ctx.fail('service', `eBay had a server problem (HTTP ${err.status ?? 500})${DOWN}`);
    if (err instanceof EbayError && err.status === undefined) return ctx.fail('network', 'Could not reach eBay to check it just now');
    return ctx.fail('service', `eBay answered in a way this app could not read${DOWN}`);
  }
}

async function checkAnthropic(key: string, ctx: Ctx): Promise<KeyCheck> {
  let res: Response;
  try {
    // The Models API: a list, no tokens generated, so free. limit=1 keeps the answer small.
    res = await ctx.fetchFn('https://api.anthropic.com/v1/models?limit=1', { method: 'GET', headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION } });
  } catch {
    return ctx.fail('network', 'Could not reach Anthropic to check it just now');
  }
  if (res.ok) return { ok: true };
  const said = saidIn(await res.json().catch(() => undefined));
  const tail = said ? ` ${said}` : '';
  const kind = kindOf(res.status);
  if (kind === 'rejected') return ctx.fail('rejected', `Claude answered${tail || ' with no reason'} (HTTP ${res.status}). Copy the key from console.anthropic.com › Settings › API keys.`);
  if (kind === 'limit') return ctx.fail('limit', `Claude is limiting calls (HTTP 429)${DOWN}`);
  return ctx.fail('service', `Claude answered${tail || ' with no reason'} (HTTP ${res.status})${DOWN}`);
}

/** The addresses an OpenAI-compatible key is used with: each pipeline that names it, once. */
export function openAiTargets(ai: KeyCheckDeps['ai']): { base: string; label: string }[] {
  const seen = new Set<string>();
  const out: { base: string; label: string }[] = [];
  for (const p of ['judge', 'assist', 'research', 'brief'] as const) {
    const s = ai?.[p];
    if (!s || s.provider !== 'openai-compatible' || s.apiKeyRef !== 'openai') continue;
    const preset = OPENAI_COMPATIBLE_PRESETS[s.preset ?? 'generic'];
    const raw = s.baseUrl?.trim() || preset.baseUrl;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    // The same refusals the provider makes: the key is never sent in the clear, or to an address carrying credentials.
    const safe = u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
    if (!safe || u.username || u.password || u.search || u.hash) continue;
    const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    if (seen.has(base)) continue;
    seen.add(base);
    out.push({ base, label: s.label ?? preset.label });
  }
  return out;
}

async function checkOpenAi(key: string, ctx: Ctx): Promise<KeyCheck> {
  const targets = openAiTargets(ctx.ai);
  if (targets.length === 0) {
    return ctx.fail('unchecked', 'No model service is set to use this key yet, so there is nothing to check it against. Choose one in Settings › AI; it is checked then.');
  }
  for (const t of targets) {
    const name = t.label === OPENAI_COMPATIBLE_PRESETS.generic.label ? 'The model service' : t.label;
    let res: Response;
    try {
      // GET {address}/models: the list every OpenAI-compatible service offers. No completion is asked for, so it is free.
      res = await ctx.fetchFn(`${t.base}/models`, { method: 'GET', headers: { authorization: `Bearer ${key}` } });
    } catch {
      return ctx.fail('network', `Could not reach ${name} to check it just now`);
    }
    if (res.ok) continue;
    if (res.status === 404 || res.status === 405) {
      return ctx.fail('unchecked', `${name} has no model list to check this key against. It is checked the first time a scan uses it.`);
    }
    const said = saidIn(await res.json().catch(() => undefined));
    const tail = said ? ` ${said}` : ' with no reason';
    const kind = kindOf(res.status);
    if (kind === 'rejected') return ctx.fail('rejected', `${name} answered${tail} (HTTP ${res.status}). Copy the key again from that service's API keys page.`);
    if (kind === 'limit') return ctx.fail('limit', `${name} is limiting calls (HTTP 429)${DOWN}`);
    return ctx.fail('service', `${name} answered${tail} (HTTP ${res.status})${DOWN}`);
  }
  return { ok: true };
}

async function checkTelegram(t: { botToken: string; chatId: string }, ctx: Ctx): Promise<KeyCheck> {
  const call = async (method: 'getMe' | 'getChat'): Promise<{ status: number; body: unknown } | null> => {
    try {
      // The token is in the address, as Telegram defines it; the fetch error's own text is never used.
      const url = `https://api.telegram.org/bot${t.botToken}/${method}${method === 'getChat' ? `?chat_id=${encodeURIComponent(t.chatId)}` : ''}`;
      const res = await ctx.fetchFn(url, { method: 'GET' });
      return { status: res.status, body: await res.json().catch(() => undefined) };
    } catch {
      return null;
    }
  };
  const refused = (r: { status: number; body: unknown }): KeyCheck => {
    const description = typeof (r.body as { description?: unknown } | undefined)?.description === 'string' ? (r.body as { description: string }).description : undefined;
    const clean = description === undefined ? undefined : ctx.scrub(description, 200);
    const kind: Kind = r.status === 400 || r.status === 404 ? 'rejected' : kindOf(r.status);
    if (kind === 'limit') return ctx.fail('limit', `Telegram is limiting calls (HTTP 429)${DOWN}`);
    if (kind === 'service') return ctx.fail('service', `Telegram had a problem (HTTP ${r.status})${DOWN}`);
    return ctx.fail('rejected', telegramProblemWords(r.status, clean));
  };

  const me = await call('getMe');
  if (!me) return ctx.fail('network', 'Could not reach Telegram to check it just now');
  const ok = (me.body as { ok?: unknown; result?: { username?: unknown } } | undefined);
  if (me.status < 200 || me.status >= 300 || ok?.ok !== true) return refused(me);
  const name = typeof ok.result?.username === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(ok.result.username) ? ok.result.username : null;

  // The chat id is the other half of the pair, and a wrong one fails only when the first message is sent. getChat is free
  // and sends nothing.
  const chat = await call('getChat');
  if (!chat) return ctx.fail('network', 'Could not reach Telegram to check it just now');
  if (chat.status < 200 || chat.status >= 300 || (chat.body as { ok?: unknown } | undefined)?.ok !== true) return refused(chat);
  return { ok: true, detail: name ? `bot @${name}, chat found` : 'bot and chat found' };
}

// ---------------------------------------------------------------- the entry points

interface Ctx extends KeyCheckDeps {
  keepaBaseUrl?: string;
  scrub(text: string, max?: number): string;
  fail(kind: Kind, problem: string): Fail;
  label: string;
}

const LABEL: Record<KeyName, string> = { serpapi: 'SerpApi', keepa: 'Keepa', anthropic: 'Anthropic', openai: 'The model service', ebay: 'eBay', telegram: 'Telegram' };

/**
 * `name`'s key, checked with its own service. `keys` holds the key to check and every other key the sentence must never
 * carry: for a stored key pass the stored keys; for a value about to be saved, the stored keys with that value in place.
 * Never throws, and never takes longer than the timeout.
 */
export async function checkKey(name: KeyName, keys: StoredKeys, deps: KeyCheckDeps & { keepaBaseUrl?: string }): Promise<KeyCheck> {
  const ms = deps.timeoutMs ?? KEY_CHECK_TIMEOUT_MS;
  const signal = AbortSignal.timeout(ms);
  const ctx: Ctx = {
    ...deps,
    fetchFn: withSignal(deps.fetchFn, signal),
    label: LABEL[name],
    scrub: (text, max = 300) => scrubKeyText(text, keys, max),
    fail: (kind, problem) => ({ ok: false, kind, problem: scrubKeyText(problem, keys) }),
  };
  const run = async (): Promise<KeyCheck> => {
    switch (name) {
      case 'serpapi':
        return keys.serpapi ? checkSerpApi(keys.serpapi, ctx) : ctx.fail('rejected', 'No SerpApi key is saved.');
      case 'keepa':
        return keys.keepa ? checkKeepa(keys.keepa, ctx) : ctx.fail('rejected', 'No Keepa key is saved.');
      case 'anthropic':
        return keys.anthropic ? checkAnthropic(keys.anthropic, ctx) : ctx.fail('rejected', 'No Anthropic key is saved.');
      case 'openai':
        return keys.openai ? checkOpenAi(keys.openai, ctx) : ctx.fail('rejected', 'No OpenAI-compatible key is saved.');
      case 'ebay':
        return keys.ebay ? checkEbay(keys.ebay, ctx) : ctx.fail('rejected', 'No eBay keys are saved.');
      case 'telegram':
        return keys.telegram ? checkTelegram(keys.telegram, ctx) : ctx.fail('rejected', 'No Telegram bot is saved.');
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<KeyCheck>((resolve) => {
    timer = setTimeout(() => resolve(ctx.fail('network', `Could not reach ${ctx.label === 'The model service' ? 'the model service' : ctx.label} to check it just now`)), ms + 50);
  });
  try {
    return await Promise.race([run().catch((): KeyCheck => ctx.fail('service', `The check of ${ctx.label} went wrong inside the app${DOWN}`)), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How a check reads where it is shown. After a save, an outage says the key is saved and will be checked again; on an
 * explicit re-check it says to try again. A rejection and a success read the same either way.
 */
export function checkForOwner(check: KeyCheck, context: 'save' | 'recheck'): KeyCheck {
  if (check.ok) return check;
  if (check.kind === 'network' || check.kind === 'service' || check.kind === 'limit') {
    return { ...check, problem: context === 'save' ? `Saved. ${check.problem} — it is checked again at the next scan.` : `${check.problem}. Try again in a moment.` };
  }
  if (check.kind === 'unchecked' && context === 'save') return { ...check, problem: `Saved. ${check.problem}` };
  return check;
}

// ---------------------------------------------------------------- recording what a check found

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Writes what a check found into the runtime record the UI reads (keyProblems, keyChecks), when the stored key is still
 * the one that was checked (the owner may have replaced it while the check ran).
 *  - works: the problem goes, the verdict is noted;
 *  - rejected: the problem is the service's sentence, the verdict is noted;
 *  - network, service, limit, unchecked: nothing is known, and what was recorded stays.
 */
export function recordKeyCheck(store: Store, name: KeyName, checked: StoredKeys[KeyName], check: KeyCheck, at: string): void {
  if (!same(store.get('keys')[name], checked)) return;
  if (!check.ok && check.kind !== 'rejected') return;
  store.update('runtime', (rt) => {
    const problems = { ...(rt.keyProblems ?? {}) };
    const checks = { ...(rt.keyChecks ?? {}) };
    if (check.ok) {
      delete problems[name];
      checks[name] = { ok: true, at, ...(check.detail ? { detail: check.detail } : {}) } satisfies KeyCheckRecord;
    } else {
      problems[name] = check.problem;
      checks[name] = { ok: false, at };
    }
    return { ...rt, keyProblems: problems, keyChecks: checks };
  });
}

/** A key replaced or removed has no recorded verdict: it was about another value. */
export function forgetKeyCheck(store: Store, name: KeyName): void {
  if (store.get('runtime').keyChecks?.[name] === undefined) return;
  store.update('runtime', (rt) => {
    const { [name]: _gone, ...rest } = rt.keyChecks ?? {};
    return { ...rt, keyChecks: rest };
  });
}

export interface KeyCheckHost {
  store: Store;
  fetchFn: typeof fetch;
  now: () => number;
  serpBaseUrl?: string;
  keepaBaseUrl?: string;
  timeoutMs?: number;
}

/** The stored key `name` checked with its service and recorded. Absent key: no check is made and null comes back. */
export async function checkStoredKey(host: KeyCheckHost, name: KeyName): Promise<KeyCheck | null> {
  const keys = host.store.get('keys');
  const value = keys[name];
  if (value === undefined) return null;
  const check = await checkKey(name, keys, {
    fetchFn: host.fetchFn,
    ai: host.store.get('settings').ai,
    ...(host.serpBaseUrl ? { serpBaseUrl: host.serpBaseUrl } : {}),
    ...(host.keepaBaseUrl ? { keepaBaseUrl: host.keepaBaseUrl } : {}),
    ...(host.timeoutMs ? { timeoutMs: host.timeoutMs } : {}),
  });
  recordKeyCheck(host.store, name, value, check, new Date(host.now()).toISOString());
  return check;
}

/**
 * At agent start and then every hour: each saved key with no verdict from the last 24 hours is checked, one after another.
 * Only the free checks above exist, so this never spends anything. A check that cannot reach its service records nothing, and
 * is tried again at the next tick.
 */
export async function recheckStaleKeys(host: KeyCheckHost): Promise<KeyName[]> {
  const checked: KeyName[] = [];
  for (const name of KEY_NAMES) {
    const keys = host.store.get('keys');
    if (keys[name] === undefined) continue;
    const last = host.store.get('runtime').keyChecks?.[name]?.at;
    const age = last ? host.now() - Date.parse(last) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(age) && age < KEY_RECHECK_MS && age >= 0) continue;
    await checkStoredKey(host, name);
    checked.push(name);
  }
  return checked;
}
