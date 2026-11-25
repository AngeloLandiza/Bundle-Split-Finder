// Nov 25, new versions: once a day (and once shortly after start) the agent reads the project's public release note
//   GET https://raw.githubusercontent.com/AngeloLandiza/Bundle-Split-Finder/main/docs/release.json
// and, when it names a version newer than the running app, tells the owner once: an Activity entry, one message through the
// channels he has on, and a quiet notice in the window (state.update) with a Download button and what changed.
//
// What the request sends: nothing about the owner. A plain GET with a generic User-Agent; no key, no token, no cookie, no
// identifier, no referrer, and not the app's own version either. GitHub sees an address and the time, as for any visitor.
// Off ("Tell me when a new version is ready" in Settings, General): no request at all.
//
// The app never downloads or runs anything. The link goes to the browser when the owner presses Download; he runs the
// installer himself. The file is read strictly (core/src/release/note.ts): size capped, every field checked, the link held
// to three hosts. A failure is silent to the owner and one line for a developer; it changes nothing the owner sees.

import type { UpdateNotice } from '../core/src/api/contract';
import {
  isNewer, MAX_FILE_BYTES, parseReleaseNote, parseSemver, RELEASE_URL, releaseChanges, releaseMessage, type ParsedRelease,
} from '../core/src/release/note';
import type { ReleaseRuntime, Store } from './store';

/** The next look comes this long after the last. */
export const RELEASE_EVERY_MS = 24 * 3_600_000;
/** After a failed look the next comes sooner (the network may be down for a while): this long after it. */
export const RELEASE_RETRY_MS = 6 * 3_600_000;
export const RELEASE_TIMEOUT_MS = 8_000;
const KEEP = 20;

const EMPTY: ReleaseRuntime = { checkedAt: null, latest: null, announced: [], dismissed: [], history: [] };

export const releaseState = (store: Store): ReleaseRuntime => ({ ...EMPTY, ...(store.get('runtime').release ?? {}) });

/** Reads the response body up to the cap; null when it is longer. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body) {
    const text = await res.text();
    return text.length > max ? null : text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One plain GET of the release note. Never throws: a refusal is a short fixed reason for the developer's log (never the
 * error's own text), and the owner sees nothing.
 */
export async function fetchReleaseNote(fetchFn: typeof fetch): Promise<{ ok: true; parsed: ParsedRelease } | { ok: false; why: string }> {
  let res: Response;
  try {
    res = await fetchFn(RELEASE_URL, {
      method: 'GET',
      headers: { 'User-Agent': 'SplitFinder', Accept: 'application/json, text/plain' },
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, why: 'could not be reached' };
  }
  if (res.status !== 200) return { ok: false, why: `answered HTTP ${res.status}` };
  let text: string | null;
  try {
    text = await readCapped(res, MAX_FILE_BYTES);
  } catch {
    return { ok: false, why: 'could not be read' };
  }
  if (text === null) return { ok: false, why: `is longer than ${MAX_FILE_BYTES} bytes` };
  const parsed = parseReleaseNote(text);
  return parsed ? { ok: true, parsed } : { ok: false, why: 'is not a valid release note' };
}

export interface VersionCheckDeps {
  store: Store;
  fetchFn: typeof fetch;
  now: () => number;
  /** The running app's version (the shell's SPLIT_FINDER_APP_VERSION); null outside the app, where there is nothing to compare. */
  appVersion: string | null;
  /** The system notification and Telegram, each as the owner has them (work.ts announceVersion). */
  announce: (text: string) => Promise<void>;
  /** The state or the Activity list changed. */
  changed: () => void;
  /** One line for a developer. */
  log?: (line: string) => void;
}

export type VersionCheck = 'off' | 'unknown' | 'not-due' | 'failed' | 'current' | 'announced' | 'seen';

/**
 * One look, when it is due (`force`: at start). Off or an unknown running version: no request. A newer version is
 * announced once, ever: it is recorded before the message goes out, so a crash or a Telegram failure never repeats it.
 */
export async function checkForNewVersion(d: VersionCheckDeps, o: { force?: boolean } = {}): Promise<VersionCheck> {
  const { store } = d;
  if (store.get('settings').updates?.tellMeAboutNewVersion === false) return 'off';
  if (parseSemver(d.appVersion) === null) return 'unknown';
  const before = releaseState(store);
  if (!o.force && before.checkedAt !== null && d.now() - before.checkedAt < RELEASE_EVERY_MS) return 'not-due';

  const got = await fetchReleaseNote(d.fetchFn);
  // The owner may have switched it off while the request was out: then nothing is kept or said.
  if (store.get('settings').updates?.tellMeAboutNewVersion === false) return 'off';
  const log = d.log ?? ((line: string) => console.warn(line));
  const save = (patch: Partial<ReleaseRuntime>) => store.update('runtime', (r) => ({ ...r, release: { ...EMPTY, ...(r.release ?? {}), ...patch } }));
  if (!got.ok) {
    log(`[release] the release note ${got.why}.`);
    save({ checkedAt: d.now() - (RELEASE_EVERY_MS - RELEASE_RETRY_MS) });
    return 'failed';
  }
  const { note, linkRefused } = got.parsed;
  if (linkRefused) log('[release] the release note names a download link that is not allowed; it is shown without one.');
  save({ checkedAt: d.now(), latest: note });
  d.changed();
  if (!isNewer(note, d.appVersion)) return 'current';
  if (before.announced.includes(note.version)) return 'seen';

  const at = new Date(d.now()).toISOString();
  save({
    announced: [...before.announced, note.version].slice(-KEEP),
    history: [...before.history, { id: `ver-${note.version}`, at, version: note.version, sentence: releaseChanges(note) }].slice(-KEEP),
  });
  d.changed();
  await d.announce(releaseMessage(note)).catch(() => undefined);
  return 'announced';
}

/** What the window shows: the note for a version newer than the running app, while the setting is on and he has not closed it. */
export function updateNoticeOf(store: Store, appVersion: string | null): UpdateNotice | undefined {
  if (store.get('settings').updates?.tellMeAboutNewVersion === false) return undefined;
  const { latest, dismissed } = releaseState(store);
  if (!latest || !isNewer(latest, appVersion) || dismissed.includes(latest.version)) return undefined;
  return { version: latest.version, date: latest.date, notes: latest.notes, link: latest.downloadUrl };
}

/** The owner closed this version's notice. It stays closed (remembered per version). */
export function dismissUpdate(store: Store, version: string): void {
  const r = releaseState(store);
  if (r.dismissed.includes(version)) return;
  store.update('runtime', (rt) => ({ ...rt, release: { ...r, dismissed: [...r.dismissed, version].slice(-KEEP) } }));
}
