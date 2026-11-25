// npm run telegram:setup [-- --file <path>] [--keep]. All logic is in telegram-setup-cli.ts.
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runTelegramSetup } from './telegram-setup-cli';

const dataDir =
  process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'com.bundlesplitfinder.desktop')
    : join(homedir(), 'Library', 'Application Support', 'com.bundlesplitfinder.desktop');

process.exitCode = await runTelegramSetup(process.argv.slice(2), {
  log: console.log,
  home: homedir(),
  readFile: (p) => (existsSync(p) && statSync(p).size <= 4096 ? readFileSync(p, 'utf8') : null),
  removeFile: (p) => {
    writeFileSync(p, ' '.repeat(statSync(p).size));
    unlinkSync(p);
  },
  fetch: async (url, init) => {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return { status: r.status, json: () => r.json() };
  },
  agentToken: () => {
    const p = join(dataDir, 'agent-token');
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
  },
});
