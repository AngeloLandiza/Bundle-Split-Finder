import type { ReadPages } from '@core/scan/types';

import { agentBridgeEndpoints } from './agentBridge';

const base = agentBridgeEndpoints().url.replace(/\/api\/bridge$/, '');

type HdPending = { id: string; itemIds: number[] };

/** Fulfils a pending HD read queued by the native app (Lane D P4). */
export async function runHdReadSync(readPages: ReadPages): Promise<void> {
  let pending: HdPending | null = null;
  try {
    const res = await fetch(`${base}/api/hd-read/pending`);
    if (!res.ok) return;
    const body = (await res.json()) as { ok: boolean; pending: HdPending | null };
    pending = body.ok && body.pending ? body.pending : null;
  } catch {
    return;
  }
  if (!pending?.itemIds.length) return;
  const outcomes = await readPages(pending.itemIds.map(String));
  try {
    await fetch(`${base}/api/hd-read/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pending.id, outcomes }),
    });
  } catch {
    // ignore
  }
}