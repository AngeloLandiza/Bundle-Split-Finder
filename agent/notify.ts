// macOS desktop line for the local agent prototype (plan Phase 3). No-op elsewhere.

import { execFile } from 'node:child_process';

export function agentNotifyText(message: string): void {
  if (process.platform !== 'darwin') {
    console.log(`[notify] ${message}`);
    return;
  }
  const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${escaped}" with title "Split Finder agent"`], () => {});
}