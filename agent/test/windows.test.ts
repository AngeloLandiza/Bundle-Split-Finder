// The Windows paths of the agent, tested on any OS: what runs and with which arguments, never Windows itself.
import { describe, expect, it } from 'vitest';

import { unzipCommand } from '../setup';
import { renameOver } from '../store';
import {
  aclSentence,
  icaclsOwnerOnlyArgs,
  makeOwnerOnly,
  ownerOnlyProblem,
  parseIcaclsEntries,
  parseUserName,
  parseUserSid,
  reportAclProblem,
  setAclReporter,
} from '../winAcl';

// `whoami /user /fo csv /nh` as Windows 11 prints it (the account and SID here are made up).
const WHOAMI = '"desktop-7q2k\\alex","S-1-5-21-3623811015-3361044348-30300820-1013"\r\n';

const FILE = 'C:\\Users\\alex\\AppData\\Roaming\\Split Finder\\store\\keys.json';
const SID = 'S-1-5-21-3623811015-3361044348-30300820-1013';
// `icacls <file>` as the first runner showed it: the folder's three inherited entries.
const INHERITED = [
  `${FILE} NT AUTHORITY\\SYSTEM:(I)(F)`,
  '                                                                   BUILTIN\\Administrators:(I)(F)',
  '                                                                   DESKTOP-7Q2K\\alex:(I)(F)',
  '',
  'Successfully processed 1 files; Failed processing 0 files',
  '',
].join('\r\n');
// After the narrowing: one explicit entry (no (I)).
// After the narrowing, as run 4 on windows-latest printed it: three explicit entries, no (I).
const NARROWED = [
  `${FILE} NT AUTHORITY\\SYSTEM:(F)`,
  '                                                                   BUILTIN\\Administrators:(F)',
  '                                                                   DESKTOP-7Q2K\\alex:(F)',
  '',
  'Successfully processed 1 files; Failed processing 0 files',
  '',
].join('\r\n');
const SYS32 = 'C:\\Windows\\System32';

describe('owner-only files on Windows (winAcl)', () => {
  it('reads the SID and name from whoami and grants the user, SYSTEM and Administrators by SID, with inheritance removed', () => {
    expect(parseUserSid(WHOAMI)).toBe(SID);
    expect(parseUserName(WHOAMI)).toBe('desktop-7q2k\\alex');
    expect(parseUserSid('INFO: nothing\r\n')).toBeNull();
    expect(icaclsOwnerOnlyArgs(FILE, SID)).toEqual([FILE, '/inheritance:r', '/grant:r', `*${SID}:F`, '*S-1-5-18:F', '*S-1-5-32-544:F', '/q']);
  });

  it('parses icacls output and accepts exactly the explicit user, SYSTEM, Administrators set', () => {
    const inherited = parseIcaclsEntries(INHERITED, FILE);
    expect(inherited.map((e) => [e.who, e.inherited])).toEqual([
      ['NT AUTHORITY\\SYSTEM', true],
      ['BUILTIN\\Administrators', true],
      ['DESKTOP-7Q2K\\alex', true],
    ]);
    const good = parseIcaclsEntries(NARROWED, FILE);
    expect(good.map((e) => [e.who, e.inherited])).toEqual([
      ['NT AUTHORITY\\SYSTEM', false],
      ['BUILTIN\\Administrators', false],
      ['DESKTOP-7Q2K\\alex', false],
    ]);
    const me = 'desktop-7q2k\\alex';
    expect(ownerOnlyProblem(good, SID, me)).toBeNull();
    // the real run-4 line
    const run4 = parseIcaclsEntries('C:\\d\\agent-token NT AUTHORITY\\SYSTEM:(F), BUILTIN\\Administrators:(F), runnervmbpeip\\runneradmin:(F)'.split(', ').join('\r\n'), 'C:\\d\\agent-token');
    expect(ownerOnlyProblem(run4, 'S-1-5-21-1-2-3-500', 'runnervmbpeip\\runneradmin')).toBeNull();
    // inherited (I)(F) fails, whatever the names
    expect(ownerOnlyProblem(inherited, SID, me)).toBe('it still inherits NT AUTHORITY\\SYSTEM, BUILTIN\\Administrators, DESKTOP-7Q2K\\alex from its folder');
    // another account fails
    const users = [...good, { who: 'BUILTIN\\Users', inherited: false, rights: '(RX)' }];
    expect(ownerOnlyProblem(users, SID, me)).toBe('it also lists BUILTIN\\Users');
    // by SID, and without the user it fails
    expect(ownerOnlyProblem([{ who: SID, inherited: false, rights: '(F)' }, { who: 'S-1-5-18', inherited: false, rights: '(F)' }], SID, null)).toBeNull();
    expect(ownerOnlyProblem([{ who: 'BUILTIN\\Administrators', inherited: false, rights: '(F)' }], SID, me)).toBe('it does not list your account');
    expect(ownerOnlyProblem([], SID, null)).toBe('icacls listed no entries');
  });

  it('asks whoami once; per file: icacls to narrow, icacls to read back, all from System32', () => {
    const calls: string[][] = [];
    const run = (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (file.endsWith('whoami.exe')) return WHOAMI;
      return args.length === 1 ? NARROWED : 'Successfully processed 1 files';
    };
    const acl = makeOwnerOnly(run, SYS32);
    expect(acl.ensure(FILE)).toBeNull();
    expect(acl.ensure(FILE)).toBeNull();
    expect(calls.map((c) => c[0])).toEqual([
      `${SYS32}\\whoami.exe`,
      `${SYS32}\\icacls.exe`,
      `${SYS32}\\icacls.exe`,
      `${SYS32}\\icacls.exe`,
      `${SYS32}\\icacls.exe`,
    ]);
    expect(calls[1]!.slice(1)).toEqual(icaclsOwnerOnlyArgs(FILE, SID));
    expect(calls[2]!.slice(1)).toEqual([FILE]);
  });

  it('verify-then-report: a file that stays inherited is reported with the reason', () => {
    const run = (file: string, args: string[]) => (file.endsWith('whoami.exe') ? WHOAMI : args.length === 1 ? INHERITED : '');
    const why = makeOwnerOnly(run, SYS32).ensure(FILE);
    expect(why).toContain('it still inherits NT AUTHORITY\\SYSTEM');
    const sentences: string[] = [];
    setAclReporter((s) => sentences.push(s));
    reportAclProblem('keys.json', why!);
    setAclReporter(null);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatch(/^Windows did not let Split Finder restrict keys\.json to your account: it still inherits .*\. It is readable by this PC's administrators\.$/);
  });

  it('an icacls that throws is the reason, and ensure still reads back', () => {
    const run = (file: string, args: string[]) => {
      if (file.endsWith('whoami.exe')) return WHOAMI;
      if (args.length === 1) throw new Error('icacls.exe exited 5');
      throw new Error('Access is denied.\nmore');
    };
    expect(makeOwnerOnly(run, SYS32).ensure(FILE)).toBe('Access is denied.');
    expect(aclSentence('keys.json', 'Access is denied.')).toBe(
      "Windows did not let Split Finder restrict keys.json to your account: Access is denied. It is readable by this PC's administrators.",
    );
  });

  it('a problem reported before the store opens is delivered when it registers', () => {
    reportAclProblem('agent-token', 'early');
    const got: string[] = [];
    setAclReporter((s) => got.push(s));
    setAclReporter(null);
    expect(got).toEqual([aclSentence('agent-token', 'early')]);
  });
});

describe('renameOver', () => {
  const busy = (code: string, times: number) => {
    let n = 0;
    return {
      rename: () => {
        if (n++ < times) throw Object.assign(new Error(code), { code });
      },
      tries: () => n,
    };
  };

  it('tries again on Windows while a scanner holds the old file', () => {
    const r = busy('EPERM', 2);
    renameOver('a', 'b', 'win32', r.rename);
    expect(r.tries()).toBe(3);
  });

  it('gives up after ten tries, and never retries elsewhere or on another error', () => {
    const stuck = busy('EBUSY', 100);
    expect(() => renameOver('a', 'b', 'win32', stuck.rename)).toThrow('EBUSY');
    expect(stuck.tries()).toBe(10);
    const mac = busy('EPERM', 1);
    expect(() => renameOver('a', 'b', 'darwin', mac.rename)).toThrow('EPERM');
    expect(mac.tries()).toBe(1);
    const gone = busy('ENOENT', 1);
    expect(() => renameOver('a', 'b', 'win32', gone.rename)).toThrow('ENOENT');
    expect(gone.tries()).toBe(1);
  });
});

describe('unzipCommand', () => {
  it('uses unzip on macOS and System32 tar.exe on Windows', () => {
    expect(unzipCommand('/x/h.zip', '/d', 'darwin')).toEqual(['unzip', ['-q', '-o', '/x/h.zip', '-d', '/d']]);
    expect(unzipCommand('C:\\a\\h.zip', 'C:\\d', 'win32', 'C:\\Windows')).toEqual([
      'C:\\Windows\\System32\\tar.exe',
      ['-xf', 'C:\\a\\h.zip', '-C', 'C:\\d'],
    ]);
  });
});
