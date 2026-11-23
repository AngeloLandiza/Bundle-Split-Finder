import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AGENT_PORT = 8790;

async function waitForAgent(port: number, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/status`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Agent did not start on port ${port}`);
}

export type AgentHarness = { stop: () => void; dataDir: string; port: number };

/** Starts the Lane D agent dashboard for E2E (port 8790; do not run agent:dashboard in parallel). */
export async function startAgentHarness(): Promise<AgentHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'sf-agent-e2e-'));
  const root = resolveRepoRoot();
  const child: ChildProcess = spawn('npx', ['tsx', join(root, 'agent/server.ts')], {
    env: { ...process.env, AGENT_PORT: String(AGENT_PORT), SPLIT_FINDER_DATA_DIR: dataDir },
    stdio: 'pipe',
  });
  await waitForAgent(AGENT_PORT);
  return {
    dataDir,
    port: AGENT_PORT,
    stop: () => {
      child.kill('SIGTERM');
    },
  };
}

function resolveRepoRoot(): string {
  return join(import.meta.dirname, '..');
}

export async function agentPost(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}