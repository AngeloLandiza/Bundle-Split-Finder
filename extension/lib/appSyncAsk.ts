import { agentBridgeEndpoints } from './agentBridge';
import type { Worker } from './worker';

const base = agentBridgeEndpoints().url.replace(/\/api\/bridge$/, '');

type AskJob = { questionId: string } | { all: true };

type QueuedAsk = { job: AskJob };

/** Pushes the helper audit to the app so review / AI suggestions refresh. */
export async function pushAuditToApp(worker: Worker): Promise<void> {
  const audit = await worker.onMessage({ type: 'exportAudit' }, {});
  if (!audit.ok || typeof audit.data !== 'string') return;
  try {
    await fetch(`${base}/api/bridge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: audit.data,
    });
  } catch {
    // ignore
  }
}

/** Runs Ask AI jobs queued in the native app (Lane D). Spends Anthropic tokens when the helper has a key. */
export async function runAskSync(worker: Worker): Promise<void> {
  let jobs: QueuedAsk[] = [];
  try {
    const res = await fetch(`${base}/api/review/ask/queue`);
    if (!res.ok) return;
    const body = (await res.json()) as { ok: boolean; jobs: QueuedAsk[] };
    jobs = body.ok && Array.isArray(body.jobs) ? body.jobs : [];
  } catch {
    return;
  }
  if (!jobs.length) return;

  for (const item of jobs) {
    if ('all' in item.job && item.job.all) {
      await worker.onMessage({ type: 'askAiAll' }, {});
    } else if ('questionId' in item.job) {
      const reply = await worker.onMessage({ type: 'askAi', questionId: item.job.questionId }, {});
      if (reply.ok) await pushAuditToApp(worker);
    }
  }

  if (jobs.some((j) => 'all' in j.job && j.job.all)) {
    await pushAuditToApp(worker);
  }

  try {
    await fetch(`${base}/api/review/ask/queue/ack`, { method: 'POST' });
  } catch {
    // ignore
  }
}