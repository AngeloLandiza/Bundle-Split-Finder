import { reviewSignature } from '@core/scan/answers';
import type { ReviewAnswer } from '@core/scan/types';

import { agentBridgeEndpoints } from './agentBridge';
import type { PanelReport } from './messages';
import type { Worker } from './worker';

const base = agentBridgeEndpoints().url.replace(/\/api\/bridge$/, '');

type QueuedAnswer = { choice: number } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' };

type QueuedJob = { id: string; answer: QueuedAnswer; aiSuggestion?: boolean };

/** Applies review answers queued in the native app (Lane D P4). */
export async function runReviewSync(worker: Worker): Promise<void> {
  let jobs: QueuedJob[] = [];
  try {
    const res = await fetch(`${base}/api/review/queue`);
    if (!res.ok) return;
    const body = (await res.json()) as { ok: boolean; jobs: QueuedJob[] };
    jobs = body.ok && Array.isArray(body.jobs) ? body.jobs : [];
  } catch {
    return;
  }
  if (!jobs.length) return;

  const report = await worker.onMessage({ type: 'getReport' }, {});
  if (!report.ok || !report.data) return;
  const panel = report.data as PanelReport;

  for (const job of jobs) {
    if ('ebay' in job.answer) {
      const eq = (panel.ebayQuestions ?? []).find((r) => r.id === job.id);
      if (!eq) continue;
      await worker.onMessage(
        { type: 'answerEbay', key: eq.key, itemId: eq.itemId, answer: job.answer.ebay },
        {},
      );
      continue;
    }
    const q = panel.review.find((r) => r.id === job.id && r.answer === null);
    if (!q) continue;
    const seen = reviewSignature(q);
    let answer: ReviewAnswer;
    if ('none' in job.answer && job.answer.none) answer = { none: true, seen };
    else if ('choice' in job.answer) answer = { choice: job.answer.choice, seen };
    else if ('parts' in job.answer) answer = { parts: job.answer.parts, seen };
    else continue;
    await worker.onMessage(
      {
        type: 'answerReview',
        id: job.id,
        answer,
        ...(job.aiSuggestion ? { aiSuggestion: true as const } : {}),
      },
      {},
    );
  }

  try {
    await fetch(`${base}/api/review/queue/ack`, { method: 'POST' });
  } catch {
    // ignore
  }
}