import { expect, getState, saveKey, test } from './fixtures';
import { agentPost, startAgentHarness, type AgentHarness } from './agent-server';

let agent: AgentHarness | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  agent = await startAgentHarness();
  await agentPost(agent.port, '/api/settings', {
    appPrimaryUi: true,
    settings: { agentBridgeAfterScan: true, searchesPerScan: 5, reserve: 0 },
  });
});

test.afterAll(() => {
  agent?.stop();
  agent = null;
});

test('app scan queue triggers helper scanNow', async ({ options }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');

  await options.evaluate(async () => {
    await chrome.storage.local.set({ appPrimaryUi: true });
    await chrome.runtime.sendMessage({ type: 'runAppSync' });
  });

  const start = await agentPost(agent!.port, '/api/scan/start', {});
  expect(start.ok).toBe(true);

  await options.evaluate(async () => chrome.runtime.sendMessage({ type: 'runAppSync' }));

  await expect
    .poll(
      async () => {
        const pending = await fetch(`http://127.0.0.1:${agent!.port}/api/scan/pending`);
        const body = (await pending.json()) as { pending: null | { id: string } };
        if (body.pending !== null) return false;
        const st = await getState(options);
        return st.data.scanRunning || st.data.lastJob?.status === 'running';
      },
      { timeout: 20_000 },
    )
    .toBe(true);
});