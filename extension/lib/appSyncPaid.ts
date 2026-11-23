import type { PaidAction } from '@core/scan/types';

import { pushAuditToApp } from './appSyncAsk';
import { agentBridgeEndpoints } from './agentBridge';
import type { Worker } from './worker';

const base = agentBridgeEndpoints().url.replace(/\/api\/bridge$/, '');

type QueuedPaid = { action: PaidAction };

/** Runs paid actions (Look up / Verify) queued in the native app (Lane D P4). */
export async function runPaidSync(worker: Worker): Promise<void> {
  let jobs: QueuedPaid[] = [];
  try {
    const res = await fetch(`${base}/api/paid/queue`);
    if (!res.ok) return;
    const body = (await res.json()) as { ok: boolean; jobs: { action: PaidAction }[] };
    jobs = body.ok && Array.isArray(body.jobs) ? body.jobs.map((j) => ({ action: j.action })) : [];
  } catch {
    return;
  }
  if (!jobs.length) return;

  for (const job of jobs) {
    await worker.onMessage({ type: 'runPaid', action: job.action }, {});
  }

  try {
    await fetch(`${base}/api/paid/queue/ack`, { method: 'POST' });
  } catch {
    // ignore
  }

  await pushAuditToApp(worker);
}