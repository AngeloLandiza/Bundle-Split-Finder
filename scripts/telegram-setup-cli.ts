// npm run telegram:setup [-- --file <path>] [--keep]
//
// For an owner who is away from his computer: he puts his bot's token in a text file that reaches the computer by
// itself (iCloud Drive, from his phone), and runs this ONE command himself. The token goes from the file straight to
// the running app (its local API) and to Telegram, its own service. It is never printed, never put in a URL that is
// shown, and never passes through a chat or a person. The chat id is found, not typed: Telegram tells the bot who wrote
// to it (he sends the bot any message first). Then the app's own test message is sent, and the file is removed.
//
// Exit codes: 0 saved and tested; 2 no file or no token in it; 3 nobody has written to the bot yet; 4 Telegram or the
// app refused. Every sentence printed is free of the token (scrubbed), whatever the failure.

export const DEFAULT_FILE = 'Library/Mobile Documents/com~apple~CloudDocs/telegram.txt';
/** A bot token as BotFather writes it: the bot's numeric id, a colon, 30 or more characters. */
export const TOKEN_RE = /\b(\d{6,12}:[A-Za-z0-9_-]{30,})\b/;

export interface SetupDeps {
  log: (line: string) => void;
  home: string;
  readFile: (path: string) => string | null;
  /** Overwrites the file's bytes, then removes it. */
  removeFile: (path: string) => void;
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  /** The app's local token (agent-token in its data folder), or null when the app has never run. */
  agentToken: () => string | null;
}

const AGENT = 'http://127.0.0.1:8790';

export function tokenIn(text: string): string | null {
  return TOKEN_RE.exec(text)?.[1] ?? null;
}

/** The private chat that wrote to the bot most recently, from getUpdates' answer. */
export function chatIn(updates: unknown): string | null {
  const result = (updates as { result?: unknown })?.result;
  if (!Array.isArray(result)) return null;
  for (const u of [...result].reverse()) {
    const chat = (u as { message?: { chat?: { id?: unknown; type?: unknown } } })?.message?.chat;
    if (chat && chat.type === 'private' && (typeof chat.id === 'number' || typeof chat.id === 'string')) return String(chat.id);
  }
  return null;
}

export async function runTelegramSetup(args: string[], deps: SetupDeps): Promise<number> {
  const at = args.indexOf('--file');
  const path = at >= 0 && args[at + 1] ? args[at + 1]! : `${deps.home}/${DEFAULT_FILE}`;
  const keep = args.includes('--keep');
  const text = deps.readFile(path);
  if (text === null) {
    deps.log(`No file at ${path}. Save your bot's token there as a text file (on an iPhone: Files, iCloud Drive, a file named telegram.txt), wait for it to sync, and run this again.`);
    return 2;
  }
  const token = tokenIn(text);
  if (!token) {
    deps.log('The file holds no bot token. It looks like 1234567890:AA… and comes from BotFather.');
    return 2;
  }
  const say = (line: string) => deps.log(line.split(token).join('[token]'));
  try {
    const got = await deps.fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    if (got.status === 401 || got.status === 404) {
      say('Telegram does not know this token. Copy it again from BotFather (the whole line) and run this again.');
      return 4;
    }
    if (got.status !== 200) {
      say(`Telegram answered ${got.status}. Nothing was saved. Try again in a minute.`);
      return 4;
    }
    const chatId = chatIn(await got.json());
    if (!chatId) {
      say('Nobody has written to your bot yet. In Telegram, open your bot, press Start, send it any message, and run this again. Nothing was saved.');
      return 3;
    }
    const agentToken = deps.agentToken();
    if (!agentToken) {
      say('Split Finder has not run on this computer yet. Open it once and run this again.');
      return 4;
    }
    const headers = { Authorization: `Bearer ${agentToken}`, Origin: AGENT, 'Content-Type': 'application/json' };
    const saved = await deps.fetch(`${AGENT}/api/keys/telegram`, { method: 'PUT', headers, body: JSON.stringify({ botToken: token, chatId }) });
    if (saved.status !== 200) {
      say(`Split Finder did not take the key (it answered ${saved.status}). Is the app open?`);
      return 4;
    }
    const check = ((await saved.json()) as { check?: { ok?: boolean; sentence?: string; detail?: string } }).check;
    say(`Saved in Split Finder. ${check?.ok === false ? `Its check says: ${check.sentence ?? check.detail ?? 'not accepted'}` : 'Telegram accepts the key.'}`);
    const test = await deps.fetch(`${AGENT}/api/notify/test-telegram`, { method: 'POST', headers, body: '{}' });
    say(test.status === 200 ? 'A test message was sent: look for "Split Finder can reach you here." in Telegram.' : `The test message was not sent (the app answered ${test.status}). Use the Test button in Settings, Notifications.`);
  } catch (e) {
    say(`It did not work: ${e instanceof Error ? e.message : 'an error'}. Nothing more was done.`);
    return 4;
  }
  if (keep) {
    say(`The file was kept at ${path} (--keep). Delete it yourself: it holds your token.`);
  } else {
    try {
      deps.removeFile(path);
      say('The file with the token was removed from this computer. On your phone, also empty Recently Deleted in Files.');
    } catch {
      say(`The file could not be removed. Delete ${path} yourself: it holds your token.`);
    }
  }
  return 0;
}
