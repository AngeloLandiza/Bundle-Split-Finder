// Owner-only files on Windows. Node ignores a file mode there (0600 sets nothing), so a file the agent writes
// owner-only (the three that hold secrets: agent-token, store/keys.json, store/pairing.json) would carry the ACL it
// inherits from its folder. Under %APPDATA% that is the user, SYSTEM and Administrators, as INHERITED entries; this makes the file carry the
// user, SYSTEM and the Administrators group, as explicit entries (no inheritance), as Microsoft's OpenSSH does for keys.
//
// The narrowing is applied to the empty temp file before the content is written, and again to the FINAL path after
// the rename (idempotent), and the result is read back as SDDL with `icacls /save` (no account names, so any Windows language; PowerShell failed to run from the windowless sidecar on run 5). A read-back that cannot be run is not evidence about the file: it is logged for a developer, never put in Activity. The first real Windows run (Nov 23, GitHub
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
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

export type Run = (file: string, args: string[]) => string;

/** The user's SID from `whoami /user /fo csv /nh`: "machine\\user","S-1-5-21-…". */
export function parseUserSid(out: string): string | null {
  return /"(S-1-[0-9]+(?:-[0-9]+)+)"/.exec(out)?.[1] ?? null;
}

/** The account name (`machine\user`) from the same output. */
export function parseUserName(out: string): string | null {
  return /^\s*"([^"]+)"\s*,\s*"S-1-/.exec(out)?.[1] ?? null;
}

export const SID_SYSTEM = 'S-1-5-18';
export const SID_ADMINISTRATORS = 'S-1-5-32-544';

/**
 * The state Microsoft's OpenSSH for Windows asks of its key files: an explicit ACL (`icacls /inheritance:r /grant`) that
 * allows access only to administrators and SYSTEM, with SIDs (`*S-1-5-32-544`) for non-English systems
 * (https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement, "Host key generation"
 * and "Administrative user"). Ours adds the owner. SYSTEM and administrators can take any file regardless, and removing
 * them breaks backup and repair tools, so a user-only ACL is not the target. Granted by SID, so no name lookup.
 */
export function icaclsOwnerOnlyArgs(path: string, sid: string): string[] {
  return [path, '/inheritance:r', '/grant:r', `*${sid}:F`, `*${SID_SYSTEM}:F`, `*${SID_ADMINISTRATORS}:F`, '/q'];
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

const SYSTEM_NAMES = ['NT AUTHORITY\\SYSTEM', SID_SYSTEM];
const ADMIN_NAMES = ['BUILTIN\\ADMINISTRATORS', SID_ADMINISTRATORS];

/**
 * Null when the entries are explicit (none inherited) and name only the user, SYSTEM and Administrators, with the user
 * present; otherwise what is wrong, in one phrase. Names are matched as icacls prints them (English); a localized
 * Windows would be reported, never accepted by guess.
 */
export function ownerOnlyProblem(entries: AclEntry[], sid: string, name: string | null): string | null {
  if (entries.length === 0) return 'icacls listed no entries';
  const kind = (who: string): 'me' | 'system' | 'admins' | null => {
    const u = who.toUpperCase();
    if (u === sid.toUpperCase() || (name !== null && u === name.toUpperCase())) return 'me';
    if (SYSTEM_NAMES.includes(u)) return 'system';
    if (ADMIN_NAMES.includes(u)) return 'admins';
    return null;
  };
  const inherited = entries.filter((e) => e.inherited);
  const strangers = entries.filter((e) => kind(e.who) === null || /DENY/i.test(e.rights));
  const hasMe = entries.some((e) => kind(e.who) === 'me');
  if (inherited.length === 0 && strangers.length === 0 && hasMe) return null;
  const parts: string[] = [];
  if (inherited.length) parts.push(`it still inherits ${inherited.map((e) => e.who).join(', ')} from its folder`);
  if (strangers.length) parts.push(`it also lists ${strangers.map((e) => e.who).join(', ')}`);
  if (!hasMe) parts.push('it does not list your account');
  return parts.join('; ');
}

/** `icacls <path> /save <out> /q`: writes the file's name and its SDDL to `out` (UTF-16LE with a BOM). */
export function icaclsSaveArgs(path: string, out: string): string[] {
  return [path, '/save', out, '/q'];
}

/** The SDDL line of an icacls /save file (UTF-16LE, BOM, then the name line and the SDDL line), or null. */
export function sddlFromSaved(buf: Uint8Array): string | null {
  let text = Buffer.from(buf).toString('utf16le');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  return lines.slice(1).find((l) => l.includes('D:')) ?? null;
}

const SDDL_ALIASES: Record<string, string> = { SY: 'S-1-5-18', BA: 'S-1-5-32-544' };

/**
 * Judges an SDDL string (`O:..G:..D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-..)`) by SIDs only: the DACL is
 * protected (flag P), no ACE is inherited (ACE flag ID), every ACE allows, each for the user, SYSTEM or Administrators,
 * and the user is present. Null when so, else what is wrong.
 */
export function sddlProblem(sddl: string, sid: string): string | null {
  const d = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl.trim());
  if (!d) return 'it has no access list';
  const aces = [...d[2]!.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!.split(';'));
  if (aces.length === 0) return 'its access list is empty';
  const parts: string[] = [];
  if (!d[1]!.includes('P')) parts.push('it still inherits permissions from its folder');
  const name = (f: string[]) => SDDL_ALIASES[f[5]!] ?? f[5]!;
  const inherited = aces.filter((f) => (f[1] ?? '').includes('ID'));
  if (inherited.length) parts.push(`it carries ${inherited.length} inherited entries`);
  const denies = aces.filter((f) => f[0] !== 'A');
  if (denies.length) parts.push('it has a deny or non-allow entry');
  const allowed = new Set([sid.toUpperCase(), 'S-1-5-18', 'S-1-5-32-544']);
  const strangers = aces.filter((f) => f[0] === 'A' && !allowed.has(name(f).toUpperCase())).map(name);
  if (strangers.length) parts.push(`it also grants ${strangers.join(', ')}`);
  if (!aces.some((f) => name(f).toUpperCase() === sid.toUpperCase())) parts.push('it does not list your account');
  return parts.length ? parts.join('; ') : null;
}

/** Where the read-back puts its temp file: injected so tests need no disk. */
export interface SavedFileIo {
  tmpPath(): string;
  read(path: string): Uint8Array;
  remove(path: string): void;
}

export type Ensured =
  | null
  /** The read-back ran and the file's ACL is not the allowed one: this is what Activity says. */
  | { wrong: string }
  /** The read-back could not be run or understood: no evidence about the file, so a console line only. */
  | { unverified: string };

export interface OwnerOnly {
  /** Narrows `path` to the current user. Null when done, else why not. Does not read it back. */
  narrow(path: string): string | null;
  /** Narrows, then reads the ACL back. Null when the file holds exactly the allowed explicit entries. */
  ensure(path: string): Ensured;
}

export function makeOwnerOnly(run: Run, system32: string, io: SavedFileIo): OwnerOnly {
  let who: { sid: string; name: string | null } | null | undefined;
  const first = (err: unknown): string => {
    if (!(err instanceof Error)) return String(err);
    const e = err as Error & { stderr?: unknown };
    const stderr = (typeof e.stderr === 'string' ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : '').split(/\r?\n/).find((l) => l.trim() !== '');
    return stderr ? `${e.message.split('\n')[0]!} (${stderr.trim()})` : e.message.split('\n')[0]!;
  };
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
      let sddl: string | null;
      let sid: string;
      const out = io.tmpPath();
      try {
        const me = user();
        if (!me) return { unverified: why ?? 'whoami did not name a SID' };
        sid = me.sid;
        run(icacls, icaclsSaveArgs(path, out));
        sddl = sddlFromSaved(io.read(out));
      } catch (err) {
        return { unverified: `${why ? `${why}; ` : ''}the read-back failed: ${first(err)}` };
      } finally {
        try {
          io.remove(out);
        } catch {
          // already gone
        }
      }
      if (sddl === null) return { unverified: `${why ? `${why}; ` : ''}the read-back held no access list` };
      const problem = sddlProblem(sddl, sid);
      if (problem === null) return null;
      return { wrong: why ? `${why}; ${problem}` : problem };
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
const io: SavedFileIo = {
  tmpPath: () => join(tmpdir(), `split-finder-acl-${randomBytes(8).toString('hex')}.txt`),
  read: (path) => readFileSync(path),
  remove: (path) => rmSync(path, { force: true }),
};
const real: OwnerOnly | null = process.platform === 'win32' ? makeOwnerOnly(run, system32, io) : null;

/** Windows: narrow the (temp) file to the current user before content goes in. Elsewhere the file mode does it. */
export function restrictToOwner(path: string): boolean {
  return real ? real.narrow(path) === null : true;
}

/** Windows: after the rename, narrow the final file, read it back and report when it is not owner-only. */
export function ensureOwnerOnlyFinal(path: string, label: string): boolean {
  if (!real) return true;
  const result = real.ensure(path);
  if (result === null) return true;
  if ('unverified' in result) {
    // Not evidence about the file: a line for a developer, nothing for the owner.
    console.warn(`Could not check the permissions of ${label}: ${result.unverified}`);
    return false;
  }
  reportAclProblem(label, result.wrong);
  return false;
}
