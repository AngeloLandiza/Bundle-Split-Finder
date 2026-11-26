// Nov 25, key stacking: SerpApi and Keepa may hold several keys, each the key of its own account (another account, for
// example the owner's partner's or a paid plan). Pure: what the store keeps, how an older store reads, and the edits.
//
// At rest (keys.json, owner-only): `serpapiKeys` / `keepaKeys`, an ordered list of { id, label, addedAt, key }. The plain
// field an older build reads and writes (`serpapi` / `keepa`, one string) is kept equal to the first key's value on every
// write, so an older build that opens this store still finds a key. What such a build may have done since is read back
// here (reconcile): it can only have replaced or removed the one key it knew (the first).
//
// Rule 3: a key's value never leaves the agent. A view carries the id, the label, when it was added and its checks.

import { randomBytes } from 'node:crypto';

import type { AgentRuntime, StoredKeyEntry, StoredKeys } from './store';

export type StackedKeyName = 'serpapi' | 'keepa';
export const STACKED: readonly StackedKeyName[] = ['serpapi', 'keepa'];

/** The most keys one service may hold. */
export const MAX_KEYS = 10;
/** Labels are short words the owner types; longer is cut. */
export const MAX_LABEL = 40;

/** The id a key saved before key stacking gets: stable, so its ledger rows (which carry no id) stay its own. */
export const FIRST_KEY_ID: Record<StackedKeyName, string> = { serpapi: 'serpapi-1', keepa: 'keepa-1' };

const listField = (name: StackedKeyName): 'serpapiKeys' | 'keepaKeys' => (name === 'serpapi' ? 'serpapiKeys' : 'keepaKeys');

function validEntry(e: unknown): e is StoredKeyEntry {
  const r = e as Partial<StoredKeyEntry> | null;
  return typeof r === 'object' && r !== null && typeof r.id === 'string' && r.id.length > 0 && typeof r.key === 'string' && r.key.trim().length > 0
    && typeof r.label === 'string' && (r.addedAt === null || typeof r.addedAt === 'string');
}

/**
 * The saved keys of a service, in order (the first is the one an older build sees), whatever wrote the file last:
 *  - a store from before key stacking (the plain field only): one key, "Key 1", added date not known;
 *  - the plain field gone but a list kept: an older build removed its one key, so the first is gone and the rest stay;
 *  - the plain field changed: an older build replaced its one key; the new value takes the first place (a new id: it may
 *    be another account), under the first key's label.
 */
export function keyEntries(keys: StoredKeys, name: StackedKeyName): StoredKeyEntry[] {
  const plain = typeof keys[name] === 'string' ? keys[name]!.trim() : '';
  const raw = keys[listField(name)];
  const list = Array.isArray(raw) ? raw.filter(validEntry) : [];
  const seen = new Set<string>();
  const unique = list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  if (unique.length === 0) return plain ? [{ id: FIRST_KEY_ID[name], label: 'Key 1', addedAt: null, key: plain }] : [];
  if (!plain) return unique.slice(1);
  if (plain === unique[0]!.key) return unique;
  const rest = unique.slice(1).filter((e) => e.key !== plain);
  return [{ id: `${unique[0]!.id}-r`, label: unique[0]!.label, addedAt: null, key: plain }, ...rest];
}

/** The stored keys with this service's list set: the list, and the plain field equal to the first key (or gone). */
export function withEntries(keys: StoredKeys, name: StackedKeyName, entries: readonly StoredKeyEntry[]): StoredKeys {
  const next: StoredKeys = { ...keys };
  const field = listField(name);
  if (entries.length === 0) {
    delete next[name];
    delete next[field];
  } else {
    next[name] = entries[0]!.key;
    next[field] = entries.map((e) => ({ ...e }));
  }
  return next;
}

/** Both services' lists as keyEntries reads them, written back; `changed` when the file needs writing. */
export function normalizeKeyLists(keys: StoredKeys): { keys: StoredKeys; changed: boolean } {
  let next = keys;
  for (const name of STACKED) {
    const entries = keyEntries(next, name);
    const field = listField(name);
    const before = JSON.stringify({ plain: next[name] ?? null, list: next[field] ?? null });
    const after = withEntries(next, name, entries);
    if (JSON.stringify({ plain: after[name] ?? null, list: after[field] ?? null }) !== before) next = after;
  }
  return { keys: next, changed: next !== keys };
}

/** "Key 1", "Key 2": the next number after the keys saved, skipping a label already used. */
export function nextLabel(entries: readonly StoredKeyEntry[]): string {
  const used = new Set(entries.map((e) => e.label.trim().toLowerCase()));
  for (let n = entries.length + 1; ; n++) if (!used.has(`key ${n}`)) return `Key ${n}`;
}

/** A label as the owner typed it, tidied: one line, at most MAX_LABEL characters; empty is refused by the caller. */
export function cleanLabel(label: string): string {
  return label.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
}

export const newKeyId = (name: StackedKeyName): string => `${name}-${randomBytes(6).toString('hex')}`;

export type KeyEdit =
  | { ok: true; keys: StoredKeys; id: string }
  | { ok: false; reason: 'full' | 'duplicate' | 'not_found' | 'label' };

/** Another key for the service, at the end of the list. The same value twice is refused. */
export function addKeyEntry(keys: StoredKeys, name: StackedKeyName, value: string, at: string, label?: string, id = newKeyId(name)): KeyEdit {
  const entries = keyEntries(keys, name);
  const key = value.trim();
  if (entries.length >= MAX_KEYS) return { ok: false, reason: 'full' };
  if (entries.some((e) => e.key === key)) return { ok: false, reason: 'duplicate' };
  const named = label === undefined ? '' : cleanLabel(label);
  const entry: StoredKeyEntry = { id, label: named || nextLabel(entries), addedAt: at, key };
  return { ok: true, keys: withEntries(keys, name, [...entries, entry]), id };
}

/**
 * The plain PUT /api/keys/:name (Settings before key stacking, the first-run welcome): with no key saved it adds Key 1; with
 * keys saved it replaces the first key's value (a new id, the same label). The other keys stay.
 */
export function replaceFirstKey(keys: StoredKeys, name: StackedKeyName, value: string, at: string, id = newKeyId(name)): { keys: StoredKeys; id: string } {
  const entries = keyEntries(keys, name);
  const key = value.trim();
  const rest = entries.slice(1).filter((e) => e.key !== key);
  const first: StoredKeyEntry = { id, label: entries[0]?.label ?? 'Key 1', addedAt: at, key };
  return { keys: withEntries(keys, name, [first, ...rest]), id };
}

export function removeKeyEntry(keys: StoredKeys, name: StackedKeyName, id: string): KeyEdit {
  const entries = keyEntries(keys, name);
  if (!entries.some((e) => e.id === id)) return { ok: false, reason: 'not_found' };
  return { ok: true, keys: withEntries(keys, name, entries.filter((e) => e.id !== id)), id };
}

export function renameKeyEntry(keys: StoredKeys, name: StackedKeyName, id: string, label: string): KeyEdit {
  const entries = keyEntries(keys, name);
  const named = cleanLabel(label);
  if (!named) return { ok: false, reason: 'label' };
  if (!entries.some((e) => e.id === id)) return { ok: false, reason: 'not_found' };
  return { ok: true, keys: withEntries(keys, name, entries.map((e) => (e.id === id ? { ...e, label: named } : e))), id };
}

/** Every saved value of every stacked key, for the scrubbers. */
export function stackedSecrets(keys: StoredKeys): string[] {
  return STACKED.flatMap((name) => keyEntries(keys, name).map((e) => e.key));
}

/**
 * One Keepa key's balance as its answer said, in the runtime record: that key's own (keepaKeys) and the sum over the keys
 * Keepa has not refused (keepa). With one key the sum is that key's figure, as before key stacking.
 */
export function keepaBalanceNoted(r: AgentRuntime, keys: StoredKeys, id: string, s: { tokensLeft: number; refillIn: number; refillRate?: number }, at: string): AgentRuntime {
  const live = new Set(keyEntries(keys, 'keepa').filter((e) => r.keyEntryChecks?.[e.id]?.ok !== false).map((e) => e.id));
  const keepaKeys = { ...(r.keepaKeys ?? {}), [id]: { tokensLeft: s.tokensLeft, refillIn: s.refillIn, refillRate: s.refillRate ?? r.keepaKeys?.[id]?.refillRate, at } };
  const mine = Object.entries(keepaKeys).filter(([k]) => live.has(k)).map(([, v]) => v);
  if (mine.length === 0) return { ...r, keepaKeys };
  return {
    ...r, keepaKeys,
    keepa: {
      tokensLeft: mine.reduce((n, v) => n + v.tokensLeft, 0),
      refillIn: Math.min(...mine.map((v) => v.refillIn)),
      ...(mine.some((v) => v.refillRate !== undefined) ? { refillRate: mine.reduce((n, v) => n + (v.refillRate ?? 0), 0) } : {}),
      at,
    },
  };
}

/** The label a sentence names a key by: "SerpApi Key 2". */
export function keyWords(name: StackedKeyName, label: string): string {
  return `${name === 'serpapi' ? 'SerpApi' : 'Keepa'} ${label}`;
}
