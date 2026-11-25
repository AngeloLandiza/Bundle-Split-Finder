// The owner hands his bot token to the app without it passing through anyone: scripts/telegram-setup-cli.ts.
// No network: fetch is a fake. The token below is made up in BotFather's shape.
import { describe, expect, it } from 'vitest';
import { chatIn, runTelegramSetup, tokenIn, type SetupDeps } from '../../scripts/telegram-setup-cli';

const TOKEN = '1234567890:AAExampleExampleExampleExample_0123-xyz';
const UPDATES = { ok: true, result: [{ message: { chat: { id: -100555, type: 'group' } } }, { message: { chat: { id: 987654321, type: 'private' } } }] };

function deps(over: Partial<SetupDeps> & { file?: string | null; routes?: Record<string, { status: number; body?: unknown }> }) {
  const lines: string[] = [];
  const calls: { url: string; body?: string }[] = [];
  const removed: string[] = [];
  const routes = over.routes ?? {};
  const d: SetupDeps = {
    log: (l) => lines.push(l),
    home: '/Users/someone',
    readFile: () => (over.file === undefined ? `my bot\n${TOKEN}\n` : over.file),
    removeFile: (p) => void removed.push(p),
    fetch: async (url, init) => {
      calls.push({ url, body: init?.body });
      const key = Object.keys(routes).find((k) => url.includes(k));
      const r = key ? routes[key]! : { status: 200, body: url.includes('getUpdates') ? UPDATES : { saved: true, check: { ok: true } } };
      return { status: r.status, json: async () => r.body ?? {} };
    },
    agentToken: () => 'local-agent-token',
    ...over,
  };
  return { d, lines, calls, removed };
}

describe('telegram:setup', () => {
  it('finds the token in a file and the private chat that wrote to the bot', () => {
    expect(tokenIn(`Use this token to access the HTTP API:\n${TOKEN}\nKeep it secure`)).toBe(TOKEN);
    expect(tokenIn('no token here 12:ab')).toBeNull();
    expect(chatIn(UPDATES)).toBe('987654321');
    expect(chatIn({ ok: true, result: [] })).toBeNull();
    expect(chatIn({ ok: true, result: [{ message: { chat: { id: -1, type: 'group' } } }] })).toBeNull();
  });

  it('saves the token and the found chat in the app, sends the test, removes the file, and never prints the token', async () => {
    const { d, lines, calls, removed } = deps({});
    expect(await runTelegramSetup([], d)).toBe(0);
    expect(calls.map((c) => c.url.replace(TOKEN, '[t]'))).toEqual([
      'https://api.telegram.org/bot[t]/getUpdates',
      'http://127.0.0.1:8790/api/keys/telegram',
      'http://127.0.0.1:8790/api/notify/test-telegram',
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ botToken: TOKEN, chatId: '987654321' });
    expect(removed).toEqual(['/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/telegram.txt']);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain('local-agent-token');
    expect(lines.some((l) => l.includes('Saved in Split Finder'))).toBe(true);
  });

  it('saves nothing when nobody has written to the bot, when the token is wrong, or when there is no file', async () => {
    const quiet = deps({ routes: { getUpdates: { status: 200, body: { ok: true, result: [] } } } });
    expect(await runTelegramSetup([], quiet.d)).toBe(3);
    expect(quiet.calls).toHaveLength(1);
    expect(quiet.removed).toEqual([]);
    const wrong = deps({ routes: { getUpdates: { status: 401 } } });
    expect(await runTelegramSetup([], wrong.d)).toBe(4);
    expect(wrong.calls).toHaveLength(1);
    const none = deps({ file: null });
    expect(await runTelegramSetup(['--file', '/tmp/x.txt'], none.d)).toBe(2);
    expect(none.calls).toHaveLength(0);
    expect(none.lines[0]).toContain('/tmp/x.txt');
  });

  it('says what the app\'s own check found when it does not accept the key', async () => {
    const { d, lines } = deps({ routes: { '/api/keys/telegram': { status: 200, body: { saved: true, check: { ok: false, problem: 'Telegram does not know this chat.', kind: 'rejected' } } } } });
    expect(await runTelegramSetup([], d)).toBe(0);
    expect(lines.join('\n')).toContain('Its check says: Telegram does not know this chat.');
  });

  it('an error that carries the token is printed without it, and --keep leaves the file', async () => {
    const boom = deps({ fetch: async () => { throw new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/getUpdates`); } });
    expect(await runTelegramSetup([], boom.d)).toBe(4);
    expect(boom.lines.join('\n')).not.toContain(TOKEN);
    expect(boom.lines.join('\n')).toContain('[token]');
    const kept = deps({});
    expect(await runTelegramSetup(['--keep'], kept.d)).toBe(0);
    expect(kept.removed).toEqual([]);
  });
});
