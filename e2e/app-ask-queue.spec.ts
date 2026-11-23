import { expect, test } from './fixtures';
import { agentPost, startAgentHarness, type AgentHarness } from './agent-server';

let agent: AgentHarness | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  agent = await startAgentHarness();
});

test.afterAll(() => {
  agent?.stop();
  agent = null;
});

test('review ask queue enqueues single and batch jobs', async () => {
  const port = agent!.port;
  const base = `http://127.0.0.1:${port}`;

  await agentPost(port, '/api/review/ask/queue/ack', {});

  const one = await agentPost(port, '/api/review/ask/queue', { questionId: 'split:test' });
  const oneBody = (await one.json()) as { ok: boolean };
  expect(oneBody.ok).toBe(true);

  const all = await agentPost(port, '/api/review/ask/queue', { all: true });
  const allBody = (await all.json()) as { ok: boolean };
  expect(allBody.ok).toBe(true);

  const listed = await fetch(`${base}/api/review/ask/queue`);
  const body = (await listed.json()) as { ok: boolean; jobs: unknown[] };
  expect(body.ok).toBe(true);
  expect(body.jobs.length).toBe(2);

  const ack = await agentPost(port, '/api/review/ask/queue/ack', {});
  const ackBody = (await ack.json()) as { ok: boolean };
  expect(ackBody.ok).toBe(true);

  const empty = await fetch(`${base}/api/review/ask/queue`);
  const after = (await empty.json()) as { jobs: unknown[] };
  expect(after.jobs).toEqual([]);
});

test('paid queue enqueues lookUp jobs', async () => {
  const port = agent!.port;
  await agentPost(port, '/api/paid/queue/ack', {});
  const res = await agentPost(port, '/api/paid/queue', {
    action: { kind: 'lookUp', parts: [{ brand: 'DEWALT', model: 'DCB205' }] },
  });
  const postBody = (await res.json()) as { ok: boolean };
  expect(postBody.ok).toBe(true);
  const listed = await fetch(`http://127.0.0.1:${port}/api/paid/queue`);
  const queueBody = (await listed.json()) as { jobs: unknown[] };
  expect(queueBody.jobs.length).toBe(1);
  await agentPost(port, '/api/paid/queue/ack', {});
});

test('deals export returns 404 without panel data', async () => {
  const res = await fetch(`http://127.0.0.1:${agent!.port}/api/deals/export`);
  expect(res.status).toBe(404);
});