// Starting the owner's Chrome for a scheduled scan (Nov 25). The agent is a Node sidecar and may start a process itself (as
// keepAwake.ts does), so there is no Rust command: nothing here needs the shell's windows.
//
// It is his ordinary Chrome with his ordinary profile: no profile flag, no automation or remote-debugging flag, no headless or
// hidden window. Home Depot must see an ordinary browser, and nothing is disguised (docs/decisions.md).
//   macOS    `open -g -a "Google Chrome"`: starts it (or leaves a running one alone) without taking focus.
//   Windows  the installed chrome.exe, found from the registry's App Paths key, else the standard install folders, started
//            minimised with `start /min` (cmd.exe, every word quoted as scripts/spawn-tool.ts does).
//   other    not supported: the start fails with a sentence, and the scan goes on without Chrome.
// A Chrome that was already running is never closed; only one this app started may be (and only when the owner said so).

import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { pathFromRegQuery, windowsChromeFolders } from '../core/src/selfRun/chrome';
import { cmdQuote } from '../scripts/spawn-tool';

/** What the agent needs of the system's Chrome. A test passes a fake. */
export interface ChromeControl {
  /** Whether a Chrome is running now. A failure to tell is "no", which only makes the app less willing to close one. */
  running(): Promise<boolean>;
  /** Starts it in the background. */
  open(): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Asks the Chrome to quit, politely. */
  quit(): Promise<boolean>;
}

export interface SystemChromeOptions {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  /** Runs a program and says whether it succeeded and what it printed (no shell). */
  run?: (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  /** Starts a command line through cmd.exe (Windows) and says whether it started. */
  start?: (line: string) => Promise<boolean>;
  exists?: (path: string) => boolean;
}

const REG_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
];

function realRun(file: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    nodeExecFile(file, args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

/** cmd.exe gets the whole line as one string, as scripts/spawn-tool.ts does; "start" returns once the process is launched. */
function realStart(line: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = nodeSpawn(line, [], { shell: true, stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/** The command line that starts `chromePath` minimised: `start "" /min "<path>"`. Throws for a path cmd.exe cannot be given safely. */
export function windowsStartLine(chromePath: string): string {
  return `start "" /min ${cmdQuote(chromePath)}`;
}

export function systemChrome(o: SystemChromeOptions = {}): ChromeControl {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const run = o.run ?? realRun;
  const start = o.start ?? realStart;
  const exists = o.exists ?? existsSync;

  async function windowsChromePath(): Promise<string | null> {
    for (const key of REG_KEYS) {
      const r = await run('reg', ['query', key, '/ve']);
      if (r.code === 0) {
        const p = pathFromRegQuery(r.stdout);
        if (p && exists(p)) return p;
      }
    }
    return windowsChromeFolders(env).find((p) => exists(p)) ?? null;
  }

  return {
    async running() {
      if (platform === 'darwin') return (await run('pgrep', ['-x', 'Google Chrome'])).code === 0;
      if (platform === 'win32') {
        const r = await run('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH', '/FO', 'CSV']);
        return r.code === 0 && /"chrome\.exe"/i.test(r.stdout);
      }
      return false;
    },
    async open() {
      if (platform === 'darwin') {
        const r = await run('open', ['-g', '-a', 'Google Chrome']);
        return r.code === 0 ? { ok: true } : { ok: false, why: 'Google Chrome was not found on this Mac.' };
      }
      if (platform === 'win32') {
        const path = await windowsChromePath();
        if (!path) return { ok: false, why: 'Chrome was not found on this computer.' };
        let line: string;
        try {
          line = windowsStartLine(path);
        } catch {
          return { ok: false, why: 'The Chrome folder has a character that cannot be started safely.' };
        }
        return (await start(line)) ? { ok: true } : { ok: false, why: 'Windows did not start Chrome.' };
      }
      return { ok: false, why: 'Opening Chrome for a scan works on macOS and Windows only.' };
    },
    async quit() {
      if (platform === 'darwin') return (await run('osascript', ['-e', 'tell application "Google Chrome" to quit'])).code === 0;
      // Without /F: Chrome is asked to close its windows, as the owner closing them would.
      if (platform === 'win32') return (await run('taskkill', ['/IM', 'chrome.exe'])).code === 0;
      return false;
    },
  };
}
