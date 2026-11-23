// Owner-only files on Windows. Node ignores a file mode there (0600 sets nothing), so a file the agent writes
// owner-only (the three that hold secrets: agent-token, store/keys.json, store/pairing.json) would carry the ACL it
// inherits from its folder. Under %APPDATA% that is the user, SYSTEM and Administrators; this narrows the file to the
// user alone, as 0600 does on macOS.
//
// The narrowing is applied to the empty temp file before the content is written, and again to the FINAL path after
// the rename (idempotent), and the result is read back with `icacls <file>`. The first real Windows run (Nov 23, GitHub
// windows-latest) showed all three secret files with the folder's three inherited entries; the agent's only failure
// signal was a console.warn in a windowless sidecar, which nobody sees. Microsoft documents that a same-volume
// MoveFileEx keeps the moved file's security descriptor
// (https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw: only a move ACROSS volumes
// assigns the destination's default descriptor), so the rename is not proven to be the culprit; what was missing was
// a check on the final file and a report the owner can read. Both are here. When the file cannot be narrowed, the
// write still happens and one sentence goes to Activity.
//
// The other store files hold no keys and keep the folder's inherited per-user permissions (user, SYSTEM,
// Administrators): the normal state of %APPDATA%, which a standard other user cannot read.

import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';

export type Run = (file: string, args: string[]) => string;

/** The user's SID from `whoami /user /fo csv /nh`: "machine\\user","S-1-5-21-…". */
export function parseUserSid(out: string): string | null {
  return /"(S-1-[0-9]+(?:-[0-9]+)+)"/.exec(out)?.[1] ?? null;
}

/** The account name (`machine\user`) from the same output. */
export function parseUserName(out: string): string | null {
  return /^\s*"([^"]+)"\s*,\s*"S-1-/.exec(out)?.[1] ?? null;
}

/** Inherited entries removed, and the one left grants the user (by SID, so no name lookup) full control. */
export function icaclsOwnerOnlyArgs(path: string, sid: string): string[] {
  return [path, '/inheritance:r', '/grant:r', `*${sid}:F`, '/q'];
}

export interface AclEntry {
  who: string;
  inherited: boolean;
  rights: string;
}

/**
 * The entries of `icacls <path>` output: the first line is the path followed by the first entry, the rest are indented
 * entries, then a blank line and "Successfully processed 1 files; Failed processing 0 files".
 *   C:\x\keys.json NT AUTHORITY\SYSTEM:(I)(F)
 *                  BUILTIN\Administrators:(I)(F)
 *                  PC\alex:(I)(F)
 */
export function parseIcaclsEntries(out: string, path: string): AclEntry[] {
  const entries: AclEntry[] = [];
  for (const raw of out.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.toLowerCase().startsWith(path.toLowerCase())) line = line.slice(path.length).trim();
    const m = /^(.+?):((?:\([^)]*\))+)$/.exec(line);
    if (!m) continue;
    const flags = m[2]!;
    entries.push({ who: m[1]!, inherited: /\(I\)/.test(flags), rights: flags });
  }
  return entries;
}

/** Null when the entries are exactly one explicit entry for the user; otherwise what is wrong, in one phrase. */
export function ownerOnlyProblem(entries: AclEntry[], sid: string, name: string | null): string | null {
  if (entries.length === 0) return 'icacls listed no entries';
  const isMe = (who: string) => who.toUpperCase() === sid.toUpperCase() || (name !== null && who.toLowerCase() === name.toLowerCase());
  const others = entries.filter((e) => !isMe(e.who));
  const inherited = entries.filter((e) => e.inherited);
  if (entries.length === 1 && others.length === 0 && inherited.length === 0) return null;
  return `it still lists ${entries.map((e) => e.who).join(', ')}${inherited.length ? ' (inherited from its folder)' : ''}`;
}

export interface OwnerOnly {
  /** Narrows `path` to the current user. Null when done, else why not. Does not read it back. */
  narrow(path: string): string | null;
  /** Narrows, then reads the ACL back. Null only when the file has exactly the one entry. */
  ensure(path: string): string | null;
}

export function makeOwnerOnly(run: Run, system32: string): OwnerOnly {
  let who: { sid: string; name: string | null } | null | undefined;
  const first = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0]! : String(err));
  const icacls = win32.join(system32, 'icacls.exe');
  const user = (): { sid: string; name: string | null } | null => {
    if (who === undefined) {
      const out = run(win32.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
      const sid = parseUserSid(out);
      who = sid ? { sid, name: parseUserName(out) } : null;
    }
    return who;
  };
  const narrow = (path: string): string | null => {
    try {
      const me = user();
      if (!me) return 'whoami did not name a SID';
      run(icacls, icaclsOwnerOnlyArgs(path, me.sid));
      return null;
    } catch (err) {
      return first(err);
    }
  };
  return {
    narrow,
    ensure(path) {
      const why = narrow(path);
      // Read back even when the grant call failed: the read says what the file really holds.
      try {
        const me = user();
        if (!me) return why ?? 'whoami did not name a SID';
        const problem = ownerOnlyProblem(parseIcaclsEntries(run(icacls, [path]), path), me.sid, me.name);
        if (problem === null) return null;
        return why ? `${why}; ${problem}` : problem;
      } catch (err) {
        return why ?? first(err);
      }
    },
  };
}

/** The one sentence for Activity when a secret-bearing file could not be narrowed. */
export function aclSentence(file: string, reason: string): string {
  return `Windows did not let Split Finder restrict ${file} to your account: ${reason.replace(/[.\s]+$/, '')}. It is readable by this PC's administrators.`;
}

// ---- reporting: sentences wait here until the store can put them in Activity.

type Listener = (sentence: string) => void;
let listener: Listener | null = null;
const pending: string[] = [];

export function reportAclProblem(file: string, reason: string): void {
  const sentence = aclSentence(file, reason);
  if (listener) listener(sentence);
  else if (!pending.includes(sentence)) {
    pending.push(sentence);
    console.warn(sentence);
  }
}

/** The store registers here; what was reported before it opened is delivered now. */
export function setAclReporter(fn: Listener | null): void {
  listener = fn;
  if (fn) for (const s of pending.splice(0)) fn(s);
}

const system32 = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const run: Run = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const real: OwnerOnly | null = process.platform === 'win32' ? makeOwnerOnly(run, system32) : null;

/** Windows: narrow the (temp) file to the current user before content goes in. Elsewhere the file mode does it. */
export function restrictToOwner(path: string): boolean {
  return real ? real.narrow(path) === null : true;
}

/** Windows: after the rename, narrow the final file, read it back and report when it is not owner-only. */
export function ensureOwnerOnlyFinal(path: string, label: string): boolean {
  if (!real) return true;
  const why = real.ensure(path);
  if (why === null) return true;
  reportAclProblem(label, why);
  return false;
}
