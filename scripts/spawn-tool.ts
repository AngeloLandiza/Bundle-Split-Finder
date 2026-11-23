// How to start an npm-installed tool (npx, npm, tsx, wxt, ...) on every OS. On Windows these are .cmd shims, which cannot be
// spawned by bare name (ENOENT) and, since Node 20.12, not at all without a shell (EINVAL). So on win32 the whole command line is
// handed to cmd.exe as one string, every part quoted; elsewhere the tool is spawned directly with its argument array.
import { execFileSync, type ExecFileSyncOptions, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** One cmd.exe word: quoted when it holds anything but plain path/option characters. Double quotes and % are refused, not escaped. */
export function cmdQuote(word: string): string {
  if (/["%\r\n]/.test(word)) throw new Error(`Cannot pass ${JSON.stringify(word)} through cmd.exe safely.`);
  return /^[A-Za-z0-9_@:.,=+\-/\\]+$/.test(word) ? word : `"${word}"`;
}

export function toolInvocation(tool: string, args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') return { file: tool, args, shell: false };
  return { file: [`${tool}.cmd`, ...args].map(cmdQuote).join(' '), args: [], shell: true };
}

export function runTool(tool: string, args: string[], options: ExecFileSyncOptions = {}): string | Buffer {
  const i = toolInvocation(tool, args);
  return execFileSync(i.file, i.args, { ...options, shell: i.shell });
}

export function spawnTool(tool: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const i = toolInvocation(tool, args);
  return spawn(i.file, i.args, { ...options, shell: i.shell });
}
