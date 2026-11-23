import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { agentDataDir } from './paths';

export type QueuedReviewAnswer =
  | { choice: number }
  | { none: true }
  | { parts: string[] }
  | { ebay: 'yes' | 'no' };

export type QueuedReview = {
  id: string;
  answer: QueuedReviewAnswer;
  /** When true, helper saves with `aiSuggestion` so outcome is tracked like Approve in the panel. */
  aiSuggestion?: boolean;
  queuedAt: string;
};

function queuePath(): string {
  return `${agentDataDir()}/review-queue.json`;
}

export function enqueueReview(
  id: string,
  answer: QueuedReviewAnswer,
  opts?: { aiSuggestion?: boolean },
): QueuedReview {
  const list = readReviewQueue();
  const job: QueuedReview = {
    id,
    answer,
    aiSuggestion: opts?.aiSuggestion === true ? true : undefined,
    queuedAt: new Date().toISOString(),
  };
  list.push(job);
  mkdirSync(dirname(queuePath()), { recursive: true });
  writeFileSync(queuePath(), JSON.stringify(list, null, 2));
  return job;
}

export function readReviewQueue(): QueuedReview[] {
  const path = queuePath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(raw) ? (raw as QueuedReview[]) : [];
  } catch {
    return [];
  }
}

export function takeReviewQueue(): QueuedReview[] {
  const jobs = readReviewQueue();
  const path = queuePath();
  if (existsSync(path)) unlinkSync(path);
  return jobs;
}

export function clearReviewQueue(): void {
  const path = queuePath();
  if (existsSync(path)) unlinkSync(path);
}