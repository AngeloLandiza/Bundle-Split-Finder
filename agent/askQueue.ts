import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { agentDataDir } from './paths';

export type AskJob = { questionId: string } | { all: true };

export type QueuedAsk = {
  job: AskJob;
  queuedAt: string;
};

function queuePath(): string {
  return `${agentDataDir()}/ask-queue.json`;
}

export function enqueueAsk(job: AskJob): QueuedAsk {
  const list = readAskQueue();
  const item: QueuedAsk = { job, queuedAt: new Date().toISOString() };
  list.push(item);
  mkdirSync(dirname(queuePath()), { recursive: true });
  writeFileSync(queuePath(), JSON.stringify(list, null, 2));
  return item;
}

export function readAskQueue(): QueuedAsk[] {
  const path = queuePath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(raw) ? (raw as QueuedAsk[]) : [];
  } catch {
    return [];
  }
}

export function takeAskQueue(): QueuedAsk[] {
  const jobs = readAskQueue();
  const path = queuePath();
  if (existsSync(path)) unlinkSync(path);
  return jobs;
}

export function clearAskQueue(): void {
  const path = queuePath();
  if (existsSync(path)) unlinkSync(path);
}