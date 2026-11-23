// The Windows paths of the agent, tested on any OS: what runs and with which arguments, never Windows itself.
import { describe, expect, it } from 'vitest';

import { unzipCommand } from '../setup';
import { renameOver } from '../store';
import { icaclsOwnerOnlyArgs, makeOwnerOnly, parseUserSid } from '../winAcl';

// `whoami /user /fo csv /nh` as Windows 11 prints it (the account and SID here are made up).
const WHOAMI = '"desktop-7q2k\\alex","S-1-5-21-3623811015-3361044348-30300820-1013"\r\n';

describe('owner-only files on Windows (winAcl)', () => {
  it('reads the SID from whoami and grants it alone, with inheritance removed', () => {
    expect(parseUserSid(WHOAMI)).toBe('S-1-5-21-3623811015-3361044348-30300820-1013');
    expect(parseUserSid('INFO: nothing\r\n')).toBeNull();
    expect(icaclsOwnerOnlyArgs('C:\\Users\\alex\\AppData\\Roaming\\x\\keys.json.42.tmp', 'S-1-5-21-1-2-3-1013')).toEqual([
      'C:\\Users\\alex\\AppData\\Roaming\\x\\keys.json.42.tmp',
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-21-1-2-3-1013:F',
      '/q',
    ]);
  });

  it('asks whoami once, runs icacls from System32 for each file', () => {
    const calls: string[][] = [];
    const run = (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return file.endsWith('whoami.exe') ? WHOAMI : 'Successfully processed 1 files';
    };
    const ownerOnly = makeOwnerOnly(run, () => {}, 'C:\\Windows\\System32');
    expect(ownerOnly('a.tmp')).toBe(true);
    expect(ownerOnly('b.tmp')).toBe(true);
    expect(calls.map((c) => c[0])).toEqual([
      'C:\\Windows\\System32\\whoami.exe',
      'C:\\Windows\\System32\\icacls.exe',
      'C:\\Windows\\System32\\icacls.exe',
    ]);
    expect(calls[2]![1]).toBe('b.tmp');
  });

  it('says once when it cannot, and the write goes on', () => {
    const warnings: string[] = [];
    const ownerOnly = makeOwnerOnly(
      () => {
        throw new Error('spawn icacls.exe ENOENT\nmore');
      },
      (m) => warnings.push(m),
      'C:\\Windows\\System32',
    );
    expect(ownerOnly('a.tmp')).toBe(false);
    expect(ownerOnly('b.tmp')).toBe(false);
    expect(warnings).toEqual(["Owner-only files keep their folder's permissions (per-user under %APPDATA%): spawn icacls.exe ENOENT"]);
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
