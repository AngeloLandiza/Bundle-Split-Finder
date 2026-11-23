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
  icaclsSaveArgs,
  sddlFromSaved,
  sddlProblem,
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

  it('judges SDDL by SIDs only, in any Windows language', () => {
    const U = 'S-1-5-21-3623811015-3361044348-30300820-1001';
    const head = 'O:BAG:S-1-5-21-3623811015-3361044348-30300820-513';
    // accepted: protected, three explicit allow entries (SY and BA are aliases of S-1-5-18 and S-1-5-32-544)
    expect(sddlProblem(`${head}D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${U})`, U)).toBeNull();
    expect(sddlProblem(`D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${U})`, U)).toBeNull();
    // Run 6 on a real runner: the user was the built-in Administrator (RID 500), which SDDL writes as LA.
    expect(sddlProblem('D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)', 'S-1-5-21-1111111111-2222222222-3333333333-500')).toBeNull();
    // LA is only the user when the user's own SID is the RID-500 account; for anyone else it is a stranger.
    expect(sddlProblem(`D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)(A;;FA;;;${U})`, U)).toBe('it also grants LA');
    expect(sddlProblem(`D:P(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)(A;;FA;;;${U})`, U)).toBeNull();
    // inheriting: not protected, inherited ACEs
    expect(sddlProblem(`${head}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${U})`, U)).toBe(
      'it still inherits permissions from its folder; it carries 3 inherited entries',
    );
    // protected but one entry still flagged inherited
    expect(sddlProblem(`D:PAI(A;ID;FA;;;SY)(A;;FA;;;${U})`, U)).toBe('it carries 1 inherited entries');
    // Users (BU) and another SID
    expect(sddlProblem(`D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${U})(A;;FRFX;;;BU)`, U)).toBe('it also grants BU');
    // a deny entry
    expect(sddlProblem(`D:P(D;;FA;;;BG)(A;;FA;;;SY)(A;;FA;;;${U})`, U)).toContain('deny');
    // the user missing
    expect(sddlProblem('D:P(A;;FA;;;SY)(A;;FA;;;BA)', U)).toBe('it does not list your account');
    expect(sddlProblem('', U)).toBe('it has no access list');
  });

  // icacls /save writes UTF-16LE with a BOM: the file's name, then its SDDL.
  const saved = (sddl: string) => Buffer.from(`\ufeff${FILE}\r\n${sddl}\r\n`, 'utf16le');
  const SDDL_OK = `D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${SID})`;
  const SDDL_INHERITED = 'D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;' + SID + ')';
  const fakeIo = (contents: () => Uint8Array) => {
    const removed: string[] = [];
    return { removed, io: { tmpPath: () => 'C:\\Temp\\split-finder-acl-ab12.txt', read: () => contents(), remove: (p: string) => void removed.push(p) } };
  };

  it('decodes a real-shaped icacls /save file and builds the command', () => {
    expect(sddlFromSaved(saved(SDDL_OK))).toBe(SDDL_OK);
    expect(sddlProblem(sddlFromSaved(saved(SDDL_OK))!, SID)).toBeNull();
    expect(sddlFromSaved(Buffer.from(`${FILE}\r\n`, 'utf16le'))).toBeNull();
    expect(sddlFromSaved(Buffer.alloc(0))).toBeNull();
    expect(icaclsSaveArgs(FILE, 'C:\\Temp\\x.txt')).toEqual([FILE, '/save', 'C:\\Temp\\x.txt', '/q']);
  });

  it('asks whoami once; per file: icacls to narrow, icacls /save to read back, the temp file removed', () => {
    const calls: string[][] = [];
    const run = (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return file.endsWith('whoami.exe') ? WHOAMI : 'Successfully processed 1 files';
    };
    const { io, removed } = fakeIo(() => saved(SDDL_OK));
    const acl = makeOwnerOnly(run, SYS32, io);
    expect(acl.ensure(FILE)).toBeNull();
    expect(acl.ensure(FILE)).toBeNull();
    expect(calls.map((c) => c[0])).toEqual([`${SYS32}\\whoami.exe`, ...Array(4).fill(`${SYS32}\\icacls.exe`)]);
    expect(calls[1]!.slice(1)).toEqual(icaclsOwnerOnlyArgs(FILE, SID));
    expect(calls[2]!.slice(1)).toEqual(icaclsSaveArgs(FILE, 'C:\\Temp\\split-finder-acl-ab12.txt'));
    expect(removed).toHaveLength(2);
  });

  it('verify-then-report: a file that stays inherited is reported with the reason', () => {
    const run = (file: string) => (file.endsWith('whoami.exe') ? WHOAMI : '');
    const result = makeOwnerOnly(run, SYS32, fakeIo(() => saved(SDDL_INHERITED)).io).ensure(FILE);
    expect(result).toEqual({ wrong: expect.stringContaining('it still inherits permissions from its folder') });
    const sentences: string[] = [];
    setAclReporter((s) => sentences.push(s));
    reportAclProblem('keys.json', (result as { wrong: string }).wrong);
    setAclReporter(null);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatch(/^Windows did not let Split Finder restrict keys\.json to your account: it still inherits .*\. It is readable by this PC's administrators\.$/);
  });

  it('a read-back that cannot run, or cannot be read, is unverified: nothing for Activity', () => {
    const stderrError = Object.assign(new Error('Command failed: icacls.exe'), { stderr: '\r\nThe system cannot find the path specified.\r\n' });
    const failing = (file: string, args: string[]) => {
      if (file.endsWith('whoami.exe')) return WHOAMI;
      if (args.includes('/save')) throw stderrError;
      return '';
    };
    const a = fakeIo(() => saved(SDDL_OK));
    const r1 = makeOwnerOnly(failing, SYS32, a.io).ensure(FILE);
    expect(r1).toEqual({ unverified: 'the read-back failed: Command failed: icacls.exe (The system cannot find the path specified.)' });
    expect(a.removed).toHaveLength(1);
    const ok = (file: string) => (file.endsWith('whoami.exe') ? WHOAMI : '');
    expect(makeOwnerOnly(ok, SYS32, fakeIo(() => Buffer.from('garbage', 'utf16le')).io).ensure(FILE)).toEqual({ unverified: 'the read-back held no access list' });
    expect(makeOwnerOnly(ok, SYS32, fakeIo(() => { throw new Error('ENOENT: no such file'); }).io).ensure(FILE)).toEqual({ unverified: 'the read-back failed: ENOENT: no such file' });
  });

  it('a narrowing that failed but a read-back that shows the right ACL is fine; a wrong one carries both reasons', () => {
    const run = (file: string, args: string[]) => {
      if (file.endsWith('whoami.exe')) return WHOAMI;
      if (!args.includes('/save')) throw new Error('Access is denied.\nmore');
      return '';
    };
    expect(makeOwnerOnly(run, SYS32, fakeIo(() => saved(SDDL_OK)).io).ensure(FILE)).toBeNull();
    expect(makeOwnerOnly(run, SYS32, fakeIo(() => saved(SDDL_INHERITED)).io).ensure(FILE)).toEqual({
      wrong: expect.stringMatching(/^Access is denied\.; it still inherits/),
    });
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
