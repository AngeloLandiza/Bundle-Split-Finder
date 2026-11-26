// What Settings, General says about new versions (docs/decisions.md, "The app updates itself from GitHub releases").
// Pure: the pane draws what these return.

import type { UpdaterState } from '../api/types';
import { when } from './format';

/** "Version 0.2.0. Last checked 10:54 AM." with what the last look found, or null outside the app. */
export function versionLine(u: UpdaterState | undefined, now: number = Date.now()): string | null {
  if (!u?.version) return null;
  const head = `Version ${u.version}.`;
  if (!u.can) return head;
  if (!u.checkedAt) return `${head} Not checked yet: Split Finder looks a minute after it opens.`;
  const at = when(u.checkedAt, now);
  if (u.outcome === 'failed') return `${head} The last look, ${at}, did not get through; it looks again in 6 hours.`;
  if (u.ready) return `${head} Version ${u.ready} is downloaded and checked (${at}).`;
  return `${head} Last checked ${at}: this is the newest.`;
}

/** The explanation under the switches. */
export function updatesHelp(u: UpdaterState | undefined): string {
  if (u && !u.can) {
    return `${u.why ?? 'This copy cannot update itself.'} Split Finder looks at the project’s public page on GitHub once a day and sends nothing about you.`;
  }
  return 'Split Finder looks at the project’s releases on GitHub a minute after it opens and every 6 hours, and sends nothing about you. A new version must carry the project’s signature or it is not installed. It installs when nothing is running and not just before a scheduled scan, then Split Finder opens again by itself. Your data, keys and settings stay as they are.';
}
