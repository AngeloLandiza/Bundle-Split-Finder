// The local agent (step 13): listens on 127.0.0.1 only. Everything it answers is in app.ts.
// npm run agent:dashboard (dev, data in ./output) or the desktop app's sidecar (data in app-data).

import { createServer } from 'node:http';

import { AGENT_PORT } from '../core/src/api/contract';
import { createAgent } from './app';
import { agentDataDir } from './paths';

const port = Number(process.env.AGENT_PORT ?? AGENT_PORT);
const extraUiOrigins = (process.env.SPLIT_FINDER_UI_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const agent = createAgent({ dataDir: agentDataDir(), port, extraUiOrigins });
const server = createServer(agent.handle);
// Long polls and event streams stay open; only idle keep-alive sockets are timed out.
server.requestTimeout = 0;
server.headersTimeout = 30_000;

server.listen(port, '127.0.0.1', () => console.log(`Split Finder agent on http://127.0.0.1:${port}/`));

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  agent.close();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
