// Two-way Telegram (Nov 25, docs/decisions.md "Acting from Telegram"). The agent reads its bot's chat by long polling
// getUpdates (no webhook: nothing listens on the network) and acts on the owner's presses and a few commands, through the same
// code the app's routes use. Only the saved chat, in a private chat, may act; anything else is ignored without an answer.
// Nothing here changes a key, a limit, a budget, the reserve or a setting, and nothing spends a search from the reserve or
// passes the cost blocker: a scan started here is the app's Scan now, under the same SearchBudget and blocker.
//
//   reading      only while a bot token is saved and "Let me act from Telegram" is on, or while a token waits for its chat
//   finding      a token saved with no chat id: the private chats that write to the bot are offered in the app, never adopted
//   buttons      each callback carries an id the agent issued and stored, with an expiry; a press uses it (and its message's
//                other buttons) once, before it acts, so a replay, a restart or a forged id does nothing
//   offset       stored before an update is handled, so an update is never handled twice across restarts
//
// Telegram Bot API (core.telegram.org/bots/api, read Nov 25 2026): getUpdates(offset, timeout, allowed_updates);
// answerCallbackQuery(callback_query_id, text); editMessageText(chat_id, message_id, text, reply_markup); sendMessage with
// reply_markup { inline_keyboard: [[{ text, callback_data (1-64 bytes) } | { text, url }]] }. The token is in the address
// Telegram defines and nowhere else: every error sentence is scrubbed of it.

import { createHash, randomBytes } from 'node:crypto';

import type { PurchaseResponse, ReviewQuestion } from '../core/src/api/contract';
import { proposedAnswer } from '../core/src/assist/stored';
import { AnswerRefused, reviewSignature } from '../core/src/scan/answers';
import { OutcomeRefused } from '../core/src/outcomes/outcomes';
import { setWatch } from '../core/src/tracking/state';
import { scrubTelegram, type InlineKeyboard, type OutgoingTelegram, type TelegramKeys } from './alerts';
import { HttpError } from './http';
import type { OutcomeBook } from './outcomes';
import type { PendingMessage, Store, TelegramActionRecord, TelegramBotRuntime } from './store';
import { dealsResponse, reviewResponse } from './views';
import { scrub, sleepFor, WorkRefused, type AgentWork } from './work';

/** getUpdates waits this long for an update before it answers with none. */
export const POLL_TIMEOUT_S = 50;
/** After a failed read: 5 s, 15 s, 1 min, then 5 min between tries. */
export const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
/** A button under a deal, a question or a scan works this long. */
export const BUTTON_TTL_MS = 48 * 3_600_000;
/** A "Yes" that confirms a purchase or a scan works this long. */
export const CONFIRM_TTL_MS = 15 * 60_000;
/** An Undo button works this long (Activity keeps its own Undo). */
export const UNDO_TTL_MS = 24 * 3_600_000;
/** The "I take /status …" line is sent at most this often. */
export const UNKNOWN_REPLY_MS = 3_600_000;
/** A command older than this (the computer slept) is not acted on. */
export const STALE_COMMAND_S = 3_600;
/** At most this many further deals and questions follow one message. */
const MAX_DEAL_FOLLOWUPS = 2;
const MAX_QUESTION_MESSAGES = 3;
/** A question with more choices than this is answered in the app. */
const MAX_CHOICES = 4;
const KEEP_ACTIONS = 500;
const KEEP_LOG = 50;
const KEEP_CANDIDATES = 5;

// ---------------------------------------------------------------- what a button does

export type Act =
  | { do: 'bought'; deal: string }
  | { do: 'buyYes'; deal: string; price: number; day: string }
  | { do: 'buyUndo'; entry: string }
  | { do: 'notForMe'; deal: string }
  | { do: 'answer'; question: string; choice: number; seen: string; suggested: boolean }
  | { do: 'answerUndo'; entry: string }
  | { do: 'skip'; question: string }
  | { do: 'open'; where: 'review' | 'costs' | 'deal' }
  | { do: 'pause' }
  | { do: 'resume' }
  | { do: 'scan' }
  | { do: 'scanYes'; may: number }
  | { do: 'no' }
  | { do: 'logUndo'; log: string };

type Button = { text: string; act: Act } | { text: string; url: string };

/** What a press did: the line added under the message, the buttons left on it, and a message that follows. */
interface Done {
  line: string;
  rows?: Button[][];
  ttl?: number;
  follow?: { text: string; rows: Button[][]; ttl: number };
}

// ---------------------------------------------------------------- Telegram's shapes (only what is read)

interface TgChat {
  id?: unknown;
  type?: unknown;
  first_name?: unknown;
  username?: unknown;
}
interface TgUser {
  id?: unknown;
  is_bot?: unknown;
}
interface TgMessage {
  message_id?: unknown;
  date?: unknown;
  chat?: TgChat;
  from?: TgUser;
  text?: unknown;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id?: unknown; from?: TgUser; message?: TgMessage; data?: unknown };
}

/** A private chat that wrote to the bot while no chat was saved, offered in the app (never adopted by itself). */
export interface ChatCandidate {
  id: string;
  name: string;
  at: number;
}

export interface TelegramBotDeps {
  store: Store;
  now: () => number;
  fetchFn: typeof fetch;
  work: Pick<AgentWork, 'answerRemembering' | 'undoAnswer' | 'scanNow' | 'serpLeft' | 'nextScanAt' | 'costs'>;
  outcomes: Pick<OutcomeBook, 'record' | 'undo'>;
  /** The app's own pause and resume (POST /api/agent/pause, /resume). */
  pause: () => void;
  resume: () => void;
  /** Waits between failed reads; tests pass one that returns at once. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** One line for a developer (default console.warn); never a key. */
  log?: (line: string) => void;
}

type CallResult<T> = { ok: true; result: T } | { ok: false; status?: number; error: string };

const usd = (n: number): string => `$${n.toFixed(2)}`;
const pad = (n: number): string => String(n).padStart(2, '0');
const localDay = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const shortDay = (t: number): string => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const cut = (t: string, n: number): string => (t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`);
const tokenTag = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16);

/** A Home Depot page, as a URL button may open it: https, homedepot.com, no user name. */
export function homeDepotUrl(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.hostname === 'www.homedepot.com' || u.hostname === 'homedepot.com' ? u.toString() : null;
  } catch {
    return null;
  }
}

export const HELP_TEXT = [
  'From here you can:',
  '/status: deals worth buying now, open questions, searches left, this month’s costs and the next scan.',
  '/pause and /resume: stop or restart scheduled scans.',
  'The buttons under messages: I bought this, Not for me, a Review answer, Pause scans, Scan now (one that spends no searches, or after your yes).',
  'Not from here: keys, limits, budgets, the reserve and settings. Those change only in the app.',
].join('\n');

const UNKNOWN_TEXT = 'I take /status, /pause, /resume and /help, and the buttons under my messages. A question is answered with its buttons, never with text. Send /help.';

function refusalOf(err: unknown): string | null {
  if (err instanceof WorkRefused || err instanceof AnswerRefused || err instanceof OutcomeRefused || err instanceof HttpError) return err.message;
  return null;
}

export class TelegramBot {
  private started = false;
  private ctl: AbortController | null = null;
  private running: Promise<void> | null = null;
  /** The token the running reader uses, and one Telegram refused (not tried again until the key changes). */
  private token: string | null = null;
  private rejected: string | null = null;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(private readonly d: TelegramBotDeps) {
    this.sleep = d.sleep ?? sleepFor;
    this.log = d.log ?? ((line) => console.warn(line));
  }

  // ------------------------------------------------------------ when it reads

  /** The saved bot and chat when the owner acts from Telegram; null otherwise. */
  private actingKeys(): TelegramKeys | null {
    const tg = this.d.store.get('keys').telegram;
    if (!tg?.botToken || !tg.chatId?.trim()) return null;
    return this.d.store.get('settings').notifications.telegramActions === true ? tg : null;
  }

  /** A saved bot token that waits for its chat (no chat id saved). */
  private findingToken(): string | null {
    const tg = this.d.store.get('keys').telegram;
    return tg?.botToken && !tg.chatId?.trim() ? tg.botToken : null;
  }

  /** The token to read with now, if any. */
  private readToken(): string | null {
    return this.actingKeys()?.botToken ?? this.findingToken();
  }

  /** Whether buttons go under the messages: a saved bot and chat, and the owner's setting on. */
  enabled(): boolean {
    return this.actingKeys() !== null;
  }

  /** Whether the reader runs now (tests). */
  get polling(): boolean {
    return this.running !== null;
  }

  /** The timers' start: from now on the reader follows the keys and the setting (sync). */
  start(): void {
    this.started = true;
    this.sync();
  }

  /** Starts, restarts or stops the reader as the keys and the setting say. Called on every change to either. */
  sync(): void {
    if (!this.started) return;
    const token = this.readToken();
    if (!token) {
      this.halt();
      return;
    }
    if (this.running && this.token === token) return;
    if (this.rejected === token) return;
    this.halt();
    this.rejected = null;
    this.token = token;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.running = this.loop(ctl.signal).finally(() => {
      if (this.ctl === ctl) {
        this.ctl = null;
        this.running = null;
        this.token = null;
      }
    });
  }

  private halt(): void {
    this.ctl?.abort();
    this.ctl = null;
    this.running = null;
    this.token = null;
  }

  stop(): void {
    this.started = false;
    this.rejected = null;
    this.halt();
  }

  /** Resolves when the reader has ended (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const token = this.readToken();
      if (!token || token !== this.token) return;
      const r = await this.pollOnce(signal);
      if (signal.aborted || r === 'off') return;
      if (r === 'rejected') {
        this.rejected = token;
        return;
      }
      if (r === 'ok') {
        failures = 0;
        continue;
      }
      failures += 1;
      try {
        await this.sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]!, signal);
      } catch {
        return;
      }
    }
  }

  // ------------------------------------------------------------ the stored state

  private botState(): TelegramBotRuntime {
    return this.d.store.get('runtime').telegramBot ?? { offset: 0, actions: {}, unknownReplyAt: null, lastError: null };
  }

  private updateBot(fn: (s: TelegramBotRuntime) => TelegramBotRuntime): void {
    this.d.store.update('runtime', (r) => ({ ...r, telegramBot: fn(r.telegramBot ?? { offset: 0, actions: {}, unknownReplyAt: null, lastError: null }) }));
  }

  // ------------------------------------------------------------ Telegram

  private async call<T>(token: string, method: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 15_000): Promise<CallResult<T>> {
    const keys: TelegramKeys = { botToken: token, chatId: '' };
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.d.fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      // The fetch error's own text is never used: it may hold the address.
      return { ok: false, error: 'Telegram could not be reached.' };
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: unknown; result?: unknown; description?: unknown };
    if (res.ok && json.ok === true) return { ok: true, result: json.result as T };
    const description = typeof json.description === 'string' ? scrubTelegram(json.description, keys) : '';
    return { ok: false, status: res.status, error: `Telegram refused ${method} (HTTP ${res.status}${description ? `: ${description}` : ''}).` };
  }

  /** A message to the saved chat, with its buttons issued now. */
  private async send(text: string, rows: Button[][] = [], ttl = BUTTON_TTL_MS): Promise<boolean> {
    const keys = this.actingKeys();
    if (!keys) return false;
    const markup = this.keyboard(rows, ttl);
    const r = await this.call(keys.botToken, 'sendMessage', { chat_id: keys.chatId, text: text.slice(0, 4096), ...(markup.inline_keyboard.length ? { reply_markup: markup } : {}) });
    if (r.ok) this.d.work.costs.count('telegram', 1);
    else this.log(`Telegram: a reply was not sent. ${r.error}`);
    return r.ok;
  }

  /**
   * One getUpdates: each update's offset is stored before it is handled, so none is handled twice, then the update. Returns
   * 'rejected' when Telegram refuses the token (reading stops until the key changes), 'error' for anything else that failed.
   */
  async pollOnce(signal?: AbortSignal): Promise<'ok' | 'error' | 'rejected' | 'off'> {
    const token = this.readToken();
    if (!token) return 'off';
    const offset = this.botState().offset;
    const r = await this.call<unknown>(
      token,
      'getUpdates',
      { ...(offset > 0 ? { offset } : {}), timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] },
      signal,
      (POLL_TIMEOUT_S + 20) * 1000,
    );
    if (signal?.aborted) return 'off';
    if (!r.ok) {
      this.updateBot((s) => ({ ...s, lastError: r.error }));
      this.log(`Telegram: reading the chat failed. ${r.error}`);
      return r.status === 401 || r.status === 404 ? 'rejected' : 'error';
    }
    const updates = (Array.isArray(r.result) ? r.result : [])
      .filter((u): u is TgUpdate => typeof (u as TgUpdate)?.update_id === 'number')
      .sort((a, b) => a.update_id - b.update_id);
    for (const u of updates) {
      if (u.update_id < this.botState().offset) continue;
      this.updateBot((s) => ({ ...s, offset: u.update_id + 1 }));
      try {
        await this.handleUpdate(u);
      } catch (err) {
        this.log(`Telegram: an update was not handled. ${scrub(err instanceof Error ? err.message : 'Something went wrong.', this.d.store.get('keys'))}`);
      }
    }
    if (this.botState().lastError !== null) this.updateBot((s) => ({ ...s, lastError: null }));
    return 'ok';
  }

  /** The saved chat, private, and the owner pressing or writing (in a private chat his user id is the chat id). */
  private fromOwner(chat: TgChat | undefined, from: TgUser | undefined): boolean {
    const keys = this.actingKeys();
    if (!keys || !chat || chat.type !== 'private') return false;
    const id = keys.chatId.trim();
    return String(chat.id) === id && from !== undefined && from.is_bot !== true && String(from.id) === id;
  }

  async handleUpdate(u: TgUpdate): Promise<void> {
    if (this.findingToken()) {
      this.noteCandidate(u);
      return;
    }
    if (u.callback_query) {
      const cq = u.callback_query;
      if (!this.fromOwner(cq.message?.chat, cq.from)) {
        this.log('Telegram: ignored a button press that is not from your chat.');
        return;
      }
      await this.handleCallback(cq);
      return;
    }
    if (u.message) {
      if (!this.fromOwner(u.message.chat, u.message.from)) {
        this.log('Telegram: ignored a message that is not from your chat.');
        return;
      }
      await this.handleMessage(u.message);
    }
  }

  // ------------------------------------------------------------ finding the chat (a token saved without a chat id)

  /** chatIn's rule (scripts/telegram-setup-cli.ts): a private chat that wrote to the bot. Kept to offer, never adopted. */
  private noteCandidate(u: TgUpdate): void {
    const token = this.findingToken();
    const chat = u.message?.chat;
    if (!token || !chat || chat.type !== 'private' || u.message?.from?.is_bot === true) return;
    if (typeof chat.id !== 'number' && typeof chat.id !== 'string') return;
    const first = typeof chat.first_name === 'string' ? chat.first_name.trim() : '';
    const user = typeof chat.username === 'string' && chat.username ? `@${chat.username}` : '';
    const name = cut([first, user].filter(Boolean).join(' ') || 'a Telegram user', 80);
    const tag = tokenTag(token);
    const at = this.d.now();
    this.updateBot((s) => {
      const kept = s.candidates?.tag === tag ? s.candidates.chats : [];
      const chats = [{ id: String(chat.id), name, at }, ...kept.filter((c) => c.id !== String(chat.id))].slice(0, KEEP_CANDIDATES);
      return { ...s, candidates: { tag, chats } };
    });
  }

  /** The chats offered for a saved token without a chat (newest first); empty when none wrote yet. */
  candidates(): ChatCandidate[] {
    const token = this.findingToken();
    const c = this.botState().candidates;
    return token && c && c.tag === tokenTag(token) ? c.chats : [];
  }

  /** The owner chose a chat in the app: saved only when it is one that wrote to this bot. */
  adoptChat(chatId: string): void {
    const tg = this.d.store.get('keys').telegram;
    if (!tg?.botToken) throw new HttpError('not_found', 'No Telegram bot is saved.');
    if (tg.chatId?.trim()) throw new HttpError('conflict', 'A chat is saved already. Remove the Telegram key to choose another.');
    if (!this.candidates().some((c) => c.id === chatId)) throw new HttpError('bad_request', 'That chat has not written to your bot. Send it a message first.');
    this.d.store.update('keys', (k) => ({ ...k, telegram: { botToken: tg.botToken, chatId } }));
    this.updateBot((s) => {
      const { candidates: _c, ...rest } = s;
      return rest;
    });
  }

  // ------------------------------------------------------------ buttons

  /** The buttons as Telegram takes them, each callback id issued and stored now (one group per keyboard). */
  private keyboard(rows: Button[][], ttl: number): InlineKeyboard {
    const now = this.d.now();
    const group = randomBytes(6).toString('base64url');
    const issued: TelegramBotRuntime['actions'] = {};
    const inline = rows
      .filter((row) => row.length > 0)
      .map((row) =>
        row.map((b) => {
          if ('url' in b) return { text: b.text, url: b.url };
          const id = randomBytes(12).toString('base64url');
          issued[id] = { act: b.act, group, issuedAt: now, expiresAt: now + ttl, usedAt: null };
          return { text: cut(b.text, 60), callback_data: `sf:${id}` };
        }),
      );
    if (Object.keys(issued).length > 0) {
      this.updateBot((s) => {
        const kept = Object.entries(s.actions).filter(([, a]) => a.expiresAt > now - 86_400_000);
        const all = [...kept, ...Object.entries(issued)].sort((a, b) => a[1].issuedAt - b[1].issuedAt).slice(-KEEP_ACTIONS);
        return { ...s, actions: Object.fromEntries(all) };
      });
    }
    return { inline_keyboard: inline };
  }

  /** Uses a callback id once: it and its message's other buttons are spent before anything is done. */
  private claim(data: unknown): { act: Act } | 'unknown' | 'used' | 'expired' {
    if (typeof data !== 'string' || !/^sf:[A-Za-z0-9_-]{16}$/.test(data)) return 'unknown';
    const id = data.slice(3);
    const entry = this.botState().actions[id];
    if (!entry) return 'unknown';
    if (entry.usedAt !== null) return 'used';
    const now = this.d.now();
    if (entry.expiresAt <= now) return 'expired';
    this.updateBot((s) => ({
      ...s,
      actions: Object.fromEntries(Object.entries(s.actions).map(([k, a]) => [k, a.group === entry.group && a.usedAt === null ? { ...a, usedAt: now } : a])),
    }));
    return { act: entry.act as Act };
  }

  private async handleCallback(cq: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    const keys = this.actingKeys()!;
    const answer = (text: string) => this.call(keys.botToken, 'answerCallbackQuery', { callback_query_id: String(cq.id), text: cut(text, 190) });
    const claimed = this.claim(cq.data);
    const messageId = typeof cq.message?.message_id === 'number' ? cq.message.message_id : null;
    if (claimed === 'unknown') {
      await answer('This button is not one the app knows. Nothing was done.');
      return;
    }
    if (claimed === 'used') {
      await answer('That was done already.');
      return;
    }
    if (claimed === 'expired') {
      await answer('This button has expired. Nothing was done. Send /status or open the app.');
      if (messageId !== null) await this.call(keys.botToken, 'editMessageReplyMarkup', { chat_id: keys.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      return;
    }
    let done: Done;
    try {
      done = await this.perform(claimed.act);
    } catch (err) {
      const why = refusalOf(err);
      if (why === null) this.log(`Telegram: a button failed. ${scrub(err instanceof Error ? err.message : 'Something went wrong.', this.d.store.get('keys'))}`);
      done = { line: `Not done: ${scrub(why ?? 'something went wrong.', this.d.store.get('keys'))} Nothing was changed; do it in the app.` };
    }
    await answer(done.line);
    if (messageId !== null) {
      const before = typeof cq.message?.text === 'string' ? cq.message.text : '';
      await this.call(keys.botToken, 'editMessageText', {
        chat_id: keys.chatId, message_id: messageId, text: `${before}\n\n${done.line}`.slice(0, 4096),
        reply_markup: this.keyboard(done.rows ?? [], done.ttl ?? UNDO_TTL_MS),
      });
    }
    if (done.follow) await this.send(done.follow.text, done.follow.rows, done.follow.ttl);
  }

  // ------------------------------------------------------------ what each button does (the app's own code)

  private async perform(act: Act): Promise<Done> {
    const { store, now } = this.d;
    switch (act.do) {
      case 'bought': {
        const deal = this.deal(act.deal);
        if (!deal) throw new HttpError('not_found', 'That deal is no longer in your deals.');
        if (deal.price === null) return { line: 'Home Depot’s price is not known here. Record it in the app with the price you paid.' };
        const day = localDay(now());
        return {
          line: 'I bought this: confirm below.',
          follow: {
            text: `Record 1 bought at ${usd(deal.price)} today (${shortDay(now())})? ${deal.name}.`,
            rows: [[{ text: 'Yes', act: { do: 'buyYes', deal: act.deal, price: deal.price, day } }, { text: 'Change in the app', act: { do: 'open', where: 'deal' } }]],
            ttl: CONFIRM_TTL_MS,
          },
        };
      }
      case 'buyYes': {
        const r: PurchaseResponse = this.d.outcomes.record({ dealId: act.deal, boughtAt: act.day, pricePaid: act.price, quantity: 1 });
        store.update('outcomes', (o) => ({ ...o, entries: o.entries.map((e) => (e.id === r.entryId ? { ...e, sentence: `${e.sentence.replace(/\.$/, '')}, from Telegram.` } : e)) }));
        const est = r.purchase.snapshot.estimate;
        const frozen = est ? ` Its estimate is kept as it stood: est. profit ${usd(est.profit)} (an estimate from your fee settings).` : '';
        return {
          line: `Recorded from Telegram: 1 bought at ${usd(act.price)} on ${shortDay(Date.parse(`${act.day}T12:00:00`))}.${frozen}`,
          rows: [[{ text: 'Undo', act: { do: 'buyUndo', entry: r.entryId } }]],
        };
      }
      case 'buyUndo':
        this.d.outcomes.undo(act.entry);
        return { line: 'Undone: the purchase is no longer recorded.' };
      case 'notForMe': {
        const deal = this.deal(act.deal);
        if (!deal) throw new HttpError('not_found', 'That deal is no longer in your deals.');
        const before = store.get('tracking').watch[act.deal] ?? null;
        store.update('tracking', (t) => ({ ...t, ...setWatch(t, act.deal, false, now()) }));
        const log = this.record(`Not for me, from Telegram: stopped watching ${deal.name}, so it is not announced again.`, { kind: 'watch', deal: act.deal, before });
        return { line: 'Not for me: you stop watching it, so it is not announced again.', rows: [[{ text: 'Undo', act: { do: 'logUndo', log } }]] };
      }
      case 'answer': {
        const { entryId } = await this.d.work.answerRemembering(act.question, { choice: act.choice }, act.seen, act.suggested, []);
        if (entryId) store.update('answers', (all) => all.map((a) => (a.id === entryId ? { ...a, answer: `${a.answer} (from Telegram)` } : a)));
        const saved = store.get('answers').find((a) => a.id === entryId)?.answer ?? 'your answer';
        return { line: `Saved: ${saved}. The deal’s estimate follows it.`, ...(entryId ? { rows: [[{ text: 'Undo', act: { do: 'answerUndo', entry: entryId } }]] } : {}) };
      }
      case 'answerUndo':
        await this.d.work.undoAnswer(act.entry);
        return { line: 'Undone: the question is open again in Review.' };
      case 'skip':
        return { line: 'Skipped. It waits in Review.' };
      case 'open':
        return {
          line: act.where === 'costs'
            ? `Costs change only in the app on your computer: Costs. ${this.d.work.costs.short().sentence}`
            : act.where === 'deal'
              ? 'Not recorded. Record it in the app (Deals, I bought this) with your own date, price and quantity.'
              : 'This one is answered in the app on your computer: Review.',
        };
      case 'pause':
        return this.pauseNow();
      case 'resume':
        return this.resumeNow();
      case 'scan':
        return this.scanPress();
      case 'scanYes': {
        const may = this.scanMaySpend();
        if (may.searches > act.may) return this.scanPress();
        return this.startScan(may);
      }
      case 'no':
        return { line: 'Not started.' };
      case 'logUndo':
        return { line: this.undoAction(act.log) };
    }
  }

  private pauseNow(): Done {
    if (this.d.store.get('agent').paused) return { line: 'Scans were paused already.', rows: [[{ text: 'Resume', act: { do: 'resume' } }]], ttl: BUTTON_TTL_MS };
    this.d.pause();
    this.record('Paused scans from Telegram.', { kind: 'pause' });
    return { line: 'Scans paused from Telegram. No scheduled scan runs until you resume.', rows: [[{ text: 'Resume', act: { do: 'resume' } }]], ttl: BUTTON_TTL_MS };
  }

  private resumeNow(): Done {
    const a = this.d.store.get('agent');
    // The agent paused itself for a problem: resuming says he read it, so that is done in the app.
    if (a.problem) throw new WorkRefused(`The app paused itself: ${a.problem} Resume it in the app once you have read why.`);
    if (!a.paused) return { line: 'Scans were not paused.' };
    this.d.resume();
    this.record('Resumed scans from Telegram.', { kind: 'resume' });
    return { line: `Scans resumed from Telegram. ${this.nextScanWords()}`, rows: [[{ text: 'Pause scans', act: { do: 'pause' } }]], ttl: BUTTON_TTL_MS };
  }

  /**
   * What Scan now may spend in searches. A scan never spends the reserve (work.ts: only Look up's explicit yes does), so at or
   * below it the scan spends none. Above it, at most the per-scan cap and what lies above the reserve. A balance from an
   * earlier month, or none, is not known: it may be any figure up to the cap.
   */
  private scanMaySpend(): { searches: number; left: number | null; reserve: number; cap: number } {
    const s = this.d.store.get('settings').settings;
    const cap = Math.max(0, Math.floor(s.searchesPerScan));
    if (!this.d.store.get('keys').serpapi) return { searches: 0, left: null, reserve: s.reserve, cap };
    const checked = this.d.store.get('runtime').serp;
    const left = this.d.work.serpLeft();
    const thisMonth = checked !== null && localDay(Date.parse(checked.at)).slice(0, 7) === localDay(this.d.now()).slice(0, 7);
    if (left === null || !thisMonth) return { searches: cap, left, reserve: s.reserve, cap };
    return { searches: Math.min(cap, Math.max(0, left - s.reserve)), left, reserve: s.reserve, cap };
  }

  private scanPress(): Done {
    const may = this.scanMaySpend();
    if (may.searches === 0) return this.startScan(may);
    const left = may.left === null ? 'the balance is not checked this month' : `${may.left} left`;
    return {
      line: 'Scan now: confirm below.',
      follow: {
        text: `This scan may spend up to ${may.searches} ${may.searches === 1 ? 'search' : 'searches'} (${left}; your reserve of ${may.reserve} is kept). Keepa and AI stay within your limits in Costs. Start it?`,
        rows: [[{ text: 'Yes, scan', act: { do: 'scanYes', may: may.searches } }, { text: 'No', act: { do: 'no' } }]],
        ttl: CONFIRM_TTL_MS,
      },
    };
  }

  private startScan(may: { searches: number; left: number | null; reserve: number }): Done {
    this.d.work.scanNow();
    const spends = may.searches === 0
      ? may.left === null ? 'It spends no searches.' : `It spends no searches: ${may.left} left is at or below your reserve of ${may.reserve}.`
      : `It may spend up to ${may.searches} ${may.searches === 1 ? 'search' : 'searches'}.`;
    this.record(`Started a scan from Telegram. ${spends}`, null);
    return { line: `Scan started from Telegram. ${spends}` };
  }

  // ------------------------------------------------------------ Activity: what was done from Telegram, with Undo

  private record(sentence: string, undo: TelegramActionRecord['undo']): string {
    const now = this.d.now();
    const id = `tg-${now}-${randomBytes(4).toString('hex')}`;
    const rec: TelegramActionRecord = { id, at: new Date(now).toISOString(), sentence, undo, undoneAt: null };
    this.d.store.update('activity', (a) => ({ ...a, fromTelegram: [...(a.fromTelegram ?? []), rec].slice(-KEEP_LOG) }));
    return id;
  }

  /** Undo of something done from Telegram (Activity's Undo and the phone's). Returns what it did, in one sentence. */
  undoAction(id: string): string {
    const { store } = this.d;
    const rec = (store.get('activity').fromTelegram ?? []).find((r) => r.id === id);
    if (!rec) throw new HttpError('not_found', 'That is not kept any more, so it cannot be undone.');
    if (rec.undoneAt) throw new HttpError('conflict', 'That was taken back already.');
    const undo = rec.undo;
    if (!undo) throw new HttpError('conflict', 'A scan cannot be undone. Stop it in the app.');
    let said: string;
    if (undo.kind === 'watch') {
      const cur = store.get('tracking').watch[undo.deal];
      if (!cur || cur.watched !== false || cur.by !== 'owner') throw new HttpError('conflict', 'The deal’s watch changed since. Change it in the app.');
      store.update('tracking', (t) => {
        const watch = { ...t.watch };
        if (undo.before) watch[undo.deal] = undo.before;
        else delete watch[undo.deal];
        return { ...t, watch };
      });
      said = 'Undone: the deal is watched again as before.';
    } else if (undo.kind === 'pause') {
      if (!store.get('agent').paused) throw new HttpError('conflict', 'Scans are not paused now.');
      if (store.get('agent').problem) throw new HttpError('conflict', 'The app paused itself since. Resume it in the app once you have read why.');
      this.d.resume();
      said = 'Undone: scans resumed.';
    } else {
      if (store.get('agent').paused) throw new HttpError('conflict', 'Scans are paused already.');
      this.d.pause();
      said = 'Undone: scans paused.';
    }
    const at = new Date(this.d.now()).toISOString();
    store.update('activity', (a) => ({ ...a, fromTelegram: (a.fromTelegram ?? []).map((r) => (r.id === id ? { ...r, undoneAt: at } : r)) }));
    return said;
  }

  // ------------------------------------------------------------ commands

  private async handleMessage(m: TgMessage): Promise<void> {
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    const cmd = /^\/([a-z]+)(?:@\w+)?$/i.exec(text)?.[1]?.toLowerCase() ?? null;
    if (cmd && typeof m.date === 'number' && this.d.now() / 1000 - m.date > STALE_COMMAND_S) {
      this.log('Telegram: a command older than an hour was not acted on.');
      return;
    }
    switch (cmd) {
      case 'status':
        await this.send(this.statusText());
        return;
      case 'pause': {
        const done = this.pauseNow();
        await this.send(done.line, done.rows, done.ttl);
        return;
      }
      case 'resume': {
        let done: Done;
        try {
          done = this.resumeNow();
        } catch (err) {
          done = { line: refusalOf(err) ?? 'Not done. Resume in the app.' };
        }
        await this.send(done.line, done.rows, done.ttl);
        return;
      }
      case 'help':
      case 'start':
        await this.send(HELP_TEXT);
        return;
      default: {
        const at = this.botState().unknownReplyAt;
        const now = this.d.now();
        if (at !== null && now - at < UNKNOWN_REPLY_MS) return;
        this.updateBot((s) => ({ ...s, unknownReplyAt: now }));
        await this.send(UNKNOWN_TEXT);
      }
    }
  }

  private nextScanWords(): string {
    if (this.d.store.get('agent').paused) return 'Scans are paused.';
    const next = this.d.work.nextScanAt();
    if (next === null) return 'No scan is scheduled: scans run when you press Scan now.';
    const at = new Date(next).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `Next scan: ${at}.`;
  }

  /** /status: Buy now with the best one, open questions, searches left, this month's costs, the next scan. */
  statusText(): string {
    const { store } = this.d;
    const rows = this.buyNowRows();
    const best = rows[0] ? this.deal(rows[0]) : null;
    const buy = rows.length === 0
      ? 'Worth buying now: none.'
      : `Worth buying now: ${rows.length} ${rows.length === 1 ? 'deal' : 'deals'}.${best ? ` Best: ${best.name}, ${best.figures}.` : ''}`;
    const open = reviewResponse({ review: store.get('review'), suggestions: store.get('suggestions'), deals: store.get('deals'), settings: store.get('settings') }).questions.length;
    const left = this.d.work.serpLeft();
    const reserve = store.get('settings').settings.reserve;
    const searches = left === null ? 'Searches left: not checked yet.' : `Searches left: ${left} (you keep ${reserve}).`;
    return [
      buy,
      `Open questions: ${open}.`,
      searches,
      `This month: ${this.d.work.costs.short().sentence}`,
      this.nextScanWords(),
      ...(rows.length ? ['Profit figures are estimates from your fee settings, not your real fees.'] : []),
    ].join('\n');
  }

  // ------------------------------------------------------------ the messages' buttons (work.ts telegramCompose)

  /** The deals worth buying now, best estimated profit first, as the Deals list counts them. */
  private buyNowRows(): string[] {
    const { store } = this.d;
    const data = { deals: store.get('deals'), review: store.get('review'), runtime: store.get('runtime'), settings: store.get('settings'), tracking: store.get('tracking') };
    return dealsResponse(data, { sort: 'profit' }, this.d.now()).rows.filter((r) => r.buyNow === true).map((r) => r.id);
  }

  /** A deal as a message names it: its name, Home Depot's price and page, and the buy figures (estimates). */
  private deal(key: string): { name: string; price: number | null; link: string | null; figures: string; buyNow: boolean } | null {
    const b = this.d.store.get('deals').bundles.find((x) => x.key === key);
    if (!b) return null;
    const t = this.d.store.get('tracking');
    const buy = t.watch[key]?.watched === true ? (t.signals[key]?.buyNow ?? null) : null;
    const n = buy?.numbers;
    const figures = n && n.profit !== null
      ? `est. profit ${usd(n.profit)}${n.roiPercent !== null ? ` (${Math.round(n.roiPercent)}% ROI)` : ''}`
      : b.estimate ? `est. profit ${usd(b.estimate.profit)}` : 'no estimate';
    return { name: `${b.brand} ${b.model || `set ${b.itemId ?? ''}`}`.trim(), price: b.price ?? null, link: homeDepotUrl(b.link), figures, buyNow: buy !== null };
  }

  private dealRows(key: string): Button[][] {
    const d = this.deal(key);
    if (!d) return [];
    return [
      [{ text: 'I bought this', act: { do: 'bought', deal: key } }, { text: 'Not for me', act: { do: 'notForMe', deal: key } }],
      ...(d.link ? [[{ text: 'Open Home Depot', url: d.link }]] : []),
    ];
  }

  private scanRow(): Button[] {
    const paused = this.d.store.get('agent').paused;
    return [paused ? { text: 'Resume', act: { do: 'resume' } } : { text: 'Pause scans', act: { do: 'pause' } }, { text: 'Scan now', act: { do: 'scan' } }];
  }

  /** A Review question with choices, in a few lines: the question, why, each choice with its source, the AI's suggestion marked. */
  private questionMessage(id: string): { text: string; rows: Button[][] } | null {
    const { store } = this.d;
    const q: ReviewQuestion | undefined = reviewResponse({ review: store.get('review'), suggestions: store.get('suggestions'), deals: store.get('deals'), settings: store.get('settings') })
      .questions.find((x) => x.id === id);
    if (!q || (q.kind !== 'split' && q.kind !== 'match') || (q.choices ?? []).length === 0) return null;
    const choices = q.choices ?? [];
    const item = q.item.kind === 'ebay' ? null : q.item.question;
    const head = `${q.prompt ?? `${q.brand} ${q.model}`} ${cut(q.reason, 160)}`;
    if (choices.length > MAX_CHOICES || !item) {
      return { text: `Review: ${head}\nIt has ${choices.length} choices: answer it in the app.`, rows: [[{ text: 'Open in the app', act: { do: 'open', where: 'review' } }]] };
    }
    const proposed = q.suggestion ? proposedAnswer(q.suggestion.suggestion, item) : null;
    const verified = q.suggestion?.suggestion.status === 'verified';
    const valueOf = (c: (typeof choices)[number]) => (q.kind === 'split' ? c.models.join(',') : c.asin ?? '');
    const lines = choices.map((c, i) => {
      const mark = proposed !== null && valueOf(c) === proposed ? ` (AI suggests this${verified ? ', verified' : ', not verified'})` : '';
      return `${i + 1}. ${cut(c.label, 90)}${mark}${c.source?.url ? ` ${c.source.url}` : ''}`;
    });
    const home = q.sources.find((s) => s.source === 'homedepot');
    const seen = q.seen ?? reviewSignature(item);
    const rows: Button[][] = choices.map((c, i) => {
      const n = Number(c.id.slice('choice:'.length));
      const suggested = proposed !== null && valueOf(c) === proposed;
      return [{ text: `${i + 1}. ${cut(c.label, 40)}${suggested ? ' (suggested)' : ''}`, act: { do: 'answer', question: q.id, choice: Number.isInteger(n) ? n : i, seen, suggested } }];
    });
    rows.push([{ text: 'Skip', act: { do: 'skip', question: q.id } }]);
    return { text: [`Review: ${head}`, ...lines, ...(home ? [`${home.label}: ${home.url}`] : [])].join('\n'), rows };
  }

  /**
   * The message as it goes out (alerts.ts sendPending), with its buttons when the owner acts from Telegram, then a message for
   * each further deal worth buying now and each new question with choices. Off, or about nothing: the text alone.
   */
  compose(m: PendingMessage): OutgoingTelegram[] {
    if (!this.enabled() || !m.about?.length) return [{ text: m.text }];
    const rows: Button[][] = [];
    const follow: { text: string; rows: Button[][] }[] = [];
    for (const a of m.about) {
      if (a.kind === 'buyNow') {
        const [top, ...rest] = a.keys;
        if (top) rows.push(...this.dealRows(top));
        for (const key of rest.slice(0, MAX_DEAL_FOLLOWUPS)) {
          const d = this.deal(key);
          if (d) follow.push({ text: `Also worth buying now: ${d.name}, ${d.figures}${d.price !== null ? ` at ${usd(d.price)}` : ''}. An estimate from your fee settings.`, rows: this.dealRows(key) });
        }
      } else if (a.kind === 'questions') {
        let n = 0;
        for (const id of a.ids) {
          if (n >= MAX_QUESTION_MESSAGES) break;
          const q = this.questionMessage(id);
          if (q) {
            follow.push(q);
            n += 1;
          }
        }
      } else if (a.kind === 'costs') {
        rows.push([{ text: 'Open Costs', act: { do: 'open', where: 'costs' } }]);
      } else if (a.kind === 'scan') {
        rows.push(this.scanRow());
      }
    }
    const markup = this.keyboard(rows, BUTTON_TTL_MS);
    return [
      { text: m.text, ...(markup.inline_keyboard.length ? { reply_markup: markup } : {}) },
      ...follow.map((f) => ({ text: f.text, reply_markup: this.keyboard(f.rows, BUTTON_TTL_MS) })),
    ];
  }
}
