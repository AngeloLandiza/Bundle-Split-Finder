// Keep the computer awake while a scan runs (Welcome, "Keep the computer awake while a scan runs"; setting
// shell.keepAwakeDuringScan). A scheduled scan that starts at 7:00 on a laptop must not be cut in half by the idle sleep.
//
// The agent holds the assertion only while the work runs, through a small child process that is killed when the work
// ends and that also ends by itself when the agent does (so a crashed agent never leaves the computer awake):
//   macOS    `caffeinate -i -w <agent pid>`: no idle sleep for as long as that process lives (man caffeinate).
//   Windows  PowerShell calling kernel32 SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) on its own thread
//            and waiting for the agent's pid; the state ends with the thread. No native dependency, no installer step.
//            Not run on a real Windows machine in development: the command is checked by a unit test only.
//   other    nothing; the scan runs as before.
// The display is not kept on: a scan needs the computer, not the screen. A failure to start the helper is logged once
// and never reaches the scan.

import { spawn as nodeSpawn } from 'node:child_process';

/** What the agent needs of a child process; a test passes a fake. */
export interface ChildLike {
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error' | 'exit', fn: (...args: never[]) => void): unknown;
  unref?(): void;
}

export type Spawner = (command: string, args: string[], options: { stdio: 'ignore'; windowsHide: boolean }) => ChildLike;

export interface KeepAwakeCommand {
  command: string;
  args: string[];
}

/** ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001): the system stays awake until the thread ends. */
const WINDOWS_SCRIPT = (pid: number): string =>
  [
    `Add-Type -Namespace Sf -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`,
    `[Sf.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null`,
    `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`,
  ].join('; ');

/** The command that holds the assertion on this platform, tied to `pid`; null where there is none. Pure. */
export function keepAwakeCommand(platform: NodeJS.Platform, pid: number): KeepAwakeCommand | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'darwin') return { command: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'win32') {
    // -EncodedCommand is base64 of UTF-16LE: no quoting rules to get wrong in a command line.
    const encoded = Buffer.from(WINDOWS_SCRIPT(pid), 'utf16le').toString('base64');
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded] };
  }
  return null;
}

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: Spawner;
  /** Where a failure to start is said, once. */
  warn?: (message: string) => void;
}

export class KeepAwake {
  private readonly cmd: KeepAwakeCommand | null;
  private readonly spawnFn: Spawner;
  private readonly warn: (message: string) => void;
  private child: ChildLike | null = null;
  private holders = 0;
  private warned = false;

  constructor(o: KeepAwakeOptions = {}) {
    this.cmd = keepAwakeCommand(o.platform ?? process.platform, o.pid ?? process.pid);
    this.spawnFn = o.spawn ?? ((command, args, options) => nodeSpawn(command, args, options) as unknown as ChildLike);
    this.warn = o.warn ?? ((m) => console.warn(m));
  }

  /** Whether an assertion is held now. */
  get active(): boolean {
    return this.child !== null;
  }

  /** Holds the computer awake until the returned function is called (once; calling it again does nothing). */
  hold(): () => void {
    this.holders += 1;
    if (this.child === null && this.cmd) this.start(this.cmd);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      if (this.holders === 0) this.stop();
    };
  }

  private start(cmd: KeepAwakeCommand): void {
    try {
      const child = this.spawnFn(cmd.command, cmd.args, { stdio: 'ignore', windowsHide: true });
      child.on('error', () => {
        // The helper is missing or refused: the scan goes on without it.
        if (this.child === child) this.child = null;
        this.sayOnce(`Keeping the computer awake during a scan is not available here (${cmd.command} did not start).`);
      });
      child.on('exit', () => {
        if (this.child === child) this.child = null;
      });
      child.unref?.();
      this.child = child;
    } catch {
      this.child = null;
      this.sayOnce(`Keeping the computer awake during a scan is not available here (${cmd.command} did not start).`);
    }
  }

  private stop(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // Already gone; its -w / Wait-Process ends it with the agent anyway.
    }
  }

  private sayOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.warn(message);
  }
}
