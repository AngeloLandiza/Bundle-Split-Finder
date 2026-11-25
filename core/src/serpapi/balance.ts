// The searches left now: the last free account figure, less every search the ledger recorded after that check.
//
// The account figure is only read when a check is made (a scan's start, its end, the drip's), so after a scan spent 17
// searches the app still showed the figure from before it (Nov 23: 97 shown, 80 real). The ledger (serpapi-ledger.jsonl,
// `{at, engine, key, label}` per search that counted) says what was spent since. Pure: no file and no clock here.

/** The last account check: searches left at `at` (ISO). */
export interface AccountFigure {
  left: number;
  at: string;
}

/**
 * A ledger row, as far as the balance reads it: when the search was made (ISO), and (key stacking, Nov 25) the id of the
 * saved key it was charged to. A row with no id was written before key stacking, or with one key: it is the first key's.
 */
export interface SpendRow {
  at: string;
  keyId?: string;
}

/** The key a row belongs to: its own id, or the first key's when it names none (rows written before key stacking). */
export function rowKeyId(row: SpendRow, firstKeyId: string): string {
  return row.keyId ?? firstKeyId;
}

/**
 * Key stacking: searches left now on each key, from each key's own last account check less the ledger rows charged to that
 * key after it (rows with no key id count as the first key's). A key with no check yet is absent. The total is the sum.
 */
export function searchesLeftByKey(
  checks: Readonly<Record<string, AccountFigure | null | undefined>>,
  rows: readonly SpendRow[],
  keyIds: readonly string[],
): { byKey: Record<string, number>; total: number | null } {
  const first = keyIds[0] ?? '';
  const byKey: Record<string, number> = {};
  let total: number | null = null;
  for (const id of keyIds) {
    const left = searchesLeftNow(checks[id], rows.filter((r) => rowKeyId(r, first) === id));
    if (left === null) continue;
    byKey[id] = left;
    total = (total ?? 0) + left;
  }
  return { byKey, total };
}

/**
 * Searches left now: `check.left` minus the rows written after `check.at` (a row at the check's own instant is part of
 * the figure). Never below 0. Null before any check. A row whose time cannot be read is counted: it may have been spent
 * after the check, and the safe error is a balance too low, not too high.
 */
export function searchesLeftNow(check: AccountFigure | null | undefined, rows: readonly SpendRow[]): number | null {
  if (!check || !Number.isFinite(check.left)) return null;
  const at = Date.parse(check.at);
  const spent = rows.filter((r) => {
    const t = Date.parse(r.at);
    return !Number.isFinite(at) || !Number.isFinite(t) || t > at;
  }).length;
  return Math.max(0, Math.floor(check.left) - spent);
}

/** The rows of a serpapi-ledger.jsonl text, a damaged line skipped. */
export function parseLedger(text: string): SpendRow[] {
  const rows: SpendRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { at?: unknown; keyId?: unknown };
      if (typeof j.at === 'string') rows.push({ at: j.at, ...(typeof j.keyId === 'string' && j.keyId ? { keyId: j.keyId } : {}) });
    } catch {
      // A half-written line is not a row.
    }
  }
  return rows;
}
