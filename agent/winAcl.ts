// Owner-only files on Windows. Node ignores a file mode there (0600 only sets nothing), so a file the agent writes
// owner-only (keys, pairing, the agent token) would carry the ACL it inherits from its folder. Under %APPDATA% that is
// already the user, SYSTEM and Administrators; this narrows the file to the user alone, as 0600 does on macOS.
//
// The ACL is set on the empty temp file before the content is written (store.ts writeFileAtomic), and a rename on
// the same volume keeps it, so the content never sits in a file anyone else may read. When icacls or whoami fails
// the file keeps its inherited ACL and the agent says so once; it does not stop.

import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';

export type Run = (file: string, args: string[]) => string;

/** The user's SID from `whoami /user /fo csv /nh`: "machine\\user","S-1-5-21-…". */
export function parseUserSid(out: string): string | null {
  return /"(S-1-[0-9]+(?:-[0-9]+)+)"/.exec(out)?.[1] ?? null;
}

/** Inherited entries removed, and the one left grants the user (by SID, so no name lookup) full control. */
export function icaclsOwnerOnlyArgs(path: string, sid: string): string[] {
  return [path, '/inheritance:r', '/grant:r', `*${sid}:F`, '/q'];
}

/** A function that narrows a file to its owner, or says once why it could not. Returns whether it did. */
export function makeOwnerOnly(run: Run, warn: (message: string) => void, system32: string): (path: string) => boolean {
  let sid: string | null | undefined;
  let warned = false;
  const fail = (why: string): false => {
    if (!warned) warn(`Owner-only files keep their folder's permissions (per-user under %APPDATA%): ${why}`);
    warned = true;
    return false;
  };
  return (path) => {
    try {
      if (sid === undefined) sid = parseUserSid(run(win32.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']));
      if (!sid) return fail('whoami did not name a SID');
      run(win32.join(system32, 'icacls.exe'), icaclsOwnerOnlyArgs(path, sid));
      return true;
    } catch (err) {
      return fail(err instanceof Error ? err.message.split('\n')[0]! : String(err));
    }
  };
}

const system32 = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const run: Run = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

/** Windows: narrow the file to the current user. Elsewhere the file mode already does it. */
export const restrictToOwner: (path: string) => boolean =
  process.platform === 'win32' ? makeOwnerOnly(run, (m) => console.warn(m), system32) : () => true;
