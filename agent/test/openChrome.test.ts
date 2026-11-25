// Starting the owner's Chrome (Nov 25): the exact commands on each system, with a fake runner and a fake start. Nothing here starts a
// browser or any process: a test that did would open Chrome on the machine running the suite.

import { describe, expect, it } from 'vitest';

import { systemChrome, windowsStartLine } from '../openChrome';

const PF = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const REG_OK = (path: string) => ({ code: 0, stdout: `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\r\n    (Default)    REG_SZ    ${path}\r\n` });

function fakes(over: { run?: (file: string, args: string[]) => { code: number; stdout: string }; exists?: (p: string) => boolean; start?: boolean } = {}) {
  const ran: [string, string[]][] = [];
  const started: string[] = [];
  return {
    ran, started,
    run: async (file: string, args: string[]) => {
      ran.push([file, args]);
      return over.run ? over.run(file, args) : { code: 0, stdout: '' };
    },
    start: async (line: string) => {
      started.push(line);
      return over.start ?? true;
    },
    exists: over.exists ?? (() => true),
  };
}

describe('macOS', () => {
  it('open -g -a "Google Chrome": the ordinary app, in the background, no profile and no flag', async () => {
    const f = fakes();
    expect(await systemChrome({ platform: 'darwin', run: f.run, start: f.start }).open()).toEqual({ ok: true });
    expect(f.ran).toEqual([['open', ['-g', '-a', 'Google Chrome']]]);
    expect(f.started).toEqual([]);
  });

  it('a Mac without Chrome says so', async () => {
    const f = fakes({ run: () => ({ code: 1, stdout: '' }) });
    expect(await systemChrome({ platform: 'darwin', run: f.run }).open()).toEqual({ ok: false, why: 'Google Chrome was not found on this Mac.' });
  });

  it('running is pgrep of the exact process name; quitting asks Chrome to quit', async () => {
    const f = fakes();
    const c = systemChrome({ platform: 'darwin', run: f.run });
    expect(await c.running()).toBe(true);
    expect(await c.quit()).toBe(true);
    expect(f.ran).toEqual([['pgrep', ['-x', 'Google Chrome']], ['osascript', ['-e', 'tell application "Google Chrome" to quit']]]);
    expect(await systemChrome({ platform: 'darwin', run: async () => ({ code: 1, stdout: '' }) }).running()).toBe(false);
  });
});

describe('Windows', () => {
  it('finds chrome.exe in the registry\'s App Paths and starts it minimised through cmd.exe', async () => {
    const f = fakes({ run: (file) => (file === 'reg' ? REG_OK(PF) : { code: 0, stdout: '' }) });
    expect(await systemChrome({ platform: 'win32', run: f.run, start: f.start, exists: f.exists, env: {} }).open()).toEqual({ ok: true });
    expect(f.ran[0]).toEqual(['reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', '/ve']]);
    expect(f.started).toEqual([`start "" /min "${PF}"`]);
  });

  it('asks the user\'s own registry key next, then the standard folders', async () => {
    const user = 'C:\\Users\\o\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    const f = fakes({ run: (file, args) => (file === 'reg' && args[1]!.startsWith('HKCU') ? REG_OK(user) : { code: 1, stdout: '' }) });
    await systemChrome({ platform: 'win32', run: f.run, start: f.start, exists: f.exists, env: {} }).open();
    expect(f.ran.map((r) => r[1]![1]!.slice(0, 4))).toEqual(['HKLM', 'HKCU']);
    // No space or special character in it: cmdQuote leaves it bare.
    expect(f.started).toEqual([`start "" /min ${user}`]);

    const folders = fakes({ run: () => ({ code: 1, stdout: '' }), exists: (p) => p.startsWith('C:\\Program Files (x86)') });
    await systemChrome({ platform: 'win32', run: folders.run, start: folders.start, exists: folders.exists, env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' } }).open();
    expect(folders.started).toEqual(['start "" /min "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"']);
  });

  it('a registry path that does not exist is not used', async () => {
    const f = fakes({ run: () => REG_OK(PF), exists: () => false });
    expect(await systemChrome({ platform: 'win32', run: f.run, start: f.start, exists: f.exists, env: {} }).open()).toEqual({ ok: false, why: 'Chrome was not found on this computer.' });
    expect(f.started).toEqual([]);
  });

  it('a path cmd.exe cannot be given safely is refused, not escaped', async () => {
    const bad = 'C:\\100%\\chrome.exe';
    expect(() => windowsStartLine(bad)).toThrow();
    const f = fakes({ run: () => REG_OK(bad) });
    expect(await systemChrome({ platform: 'win32', run: f.run, start: f.start, exists: f.exists, env: {} }).open()).toEqual({ ok: false, why: 'The Chrome folder has a character that cannot be started safely.' });
    expect(f.started).toEqual([]);
  });

  it('a start Windows refuses says so; running reads tasklist; quitting is taskkill without /F', async () => {
    const f = fakes({ run: (file) => (file === 'reg' ? REG_OK(PF) : { code: 0, stdout: '"chrome.exe","123","Console","1","200,000 K"' }), start: false });
    const c = systemChrome({ platform: 'win32', run: f.run, start: f.start, exists: f.exists, env: {} });
    expect(await c.open()).toEqual({ ok: false, why: 'Windows did not start Chrome.' });
    expect(await c.running()).toBe(true);
    expect(await c.quit()).toBe(true);
    expect(f.ran.slice(-2)).toEqual([['tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH', '/FO', 'CSV']], ['taskkill', ['/IM', 'chrome.exe']]]);
  });
});

describe('another system', () => {
  it('starts nothing and says why', async () => {
    const f = fakes();
    const c = systemChrome({ platform: 'linux', run: f.run, start: f.start });
    expect(await c.open()).toEqual({ ok: false, why: 'Opening Chrome for a scan works on macOS and Windows only.' });
    expect(await c.running()).toBe(false);
    expect(await c.quit()).toBe(false);
    expect(f.ran).toEqual([]);
    expect(f.started).toEqual([]);
  });
});
