// The local agent (step 13): listens on 127.0.0.1 only. Everything it answers is in app.ts.
// npm run agent:dashboard (dev, data in ./output) or the desktop app's sidecar (data in app-data).

import { createServer } from 'node:http';

import { AGENT_PORT } from '../core/src/api/contract';
import { createAgent, type Agent } from './app';
import { installCrashHandlers, restartFromEnv } from './crash';
import { KeepAwake } from './keepAwake';
import { systemChrome } from './openChrome';
import { agentDataDir } from './paths';

const port = Number(process.env.AGENT_PORT ?? AGENT_PORT);
const extraUiOrigins = (process.env.SPLIT_FINDER_UI_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const dataDir = agentDataDir();

// Nov 25, supervision: installed before anything can throw. The truly unexpected (a job's failure is caught where it runs)
// writes one scrubbed line to agent-crash.jsonl, releases the store lock and the keep-awake hold, and exits non-zero, so the
// desktop shell starts the agent again (src-tauri/src/agent.rs). It never keeps running in a state nobody knows.
let agent: Agent | null = null;
installCrashHandlers(process, {
  dataDir,
  secrets: () => agent?.secrets() ?? [],
  step: () => agent?.step() ?? null,
  release: () => agent?.close(),
  exit: (code) => process.exit(code),
  log: (line) => console.error(line),
});

// The real agent keeps the computer awake while a scan runs (shell.keepAwakeDuringScan) and may open the owner's Chrome for a
// scheduled scan (settings.scan.openChrome); tests build theirs without either.
agent = createAgent({ dataDir, port, extraUiOrigins, onQuit: () => stop(), work: { keepAwake: new KeepAwake(), chrome: systemChrome() }, restart: restartFromEnv(process.env) });
const server = createServer(agent.handle);
// Long polls and event streams stay open; only idle keep-alive sockets are timed out.
server.requestTimeout = 0;
server.headersTimeout = 30_000;

server.listen(port, '127.0.0.1', () => console.log(`Split Finder agent on http://127.0.0.1:${port}/ (node ${process.version})`));

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  agent?.close();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2_000).unref();
}
// macOS: the shell sends SIGTERM. Windows has none for a windowless child: the shell POSTs /api/agent/quit (onQuit).
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
