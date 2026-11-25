import { useEffect, useState, type ReactNode } from 'react';
import { api, useAction, useApp, useResource } from '../../api/hooks';
import type * as C from '@core/api/contract';
import type { KeyName } from '../../api/types';
import { Button } from '../../components/Button';
import { TextField } from '../../components/Fields';
import { Fold } from '../../components/Fold';
import { Glyph } from '../../components/Glyph';
import { KeyCheckLine, useKeyCheck } from '../../components/KeyCheck';
import { ConfirmInline } from '../../components/States';
import { ebayHints } from '../../lib/keyCheck';
import { keyState } from '../../lib/keyStatus';
import { words } from '../../lib/platform';
import { Pane, Row } from './form';

interface Def {
  name: KeyName;
  label: string;
  /** The fields, with the names the agent takes: one `key`, or the pair. `optional`: may be left empty (Telegram's chat id). */
  fields: { id: string; label: string; optional?: boolean }[];
  what: ReactNode;
  /** Where to get it: a page, or (`how`) steps in the app's own words behind a disclosure. */
  getKey?: { href: string; label: string };
  how?: ReactNode;
  /** What stops working when the key is removed. */
  without: string;
}

const KEYS: Def[] = [
  {
    name: 'serpapi',
    label: 'SerpApi',
    fields: [{ id: 'key', label: 'SerpApi key' }],
    what: 'Finds bundles on Home Depot and their listings on Amazon. The free plan has 250 searches a month.',
    getKey: { href: 'https://serpapi.com/users/sign_up', label: 'Get a key' },
    without: 'Scans and lookups need it.',
  },
  {
    name: 'keepa',
    label: 'Keepa',
    fields: [{ id: 'key', label: 'Keepa key' }],
    what: 'Amazon prices, sales rank and how many units a part sold last month.',
    getKey: { href: 'https://keepa.com/#!api', label: 'Get a key' },
    without: 'Keepa prices and sales figures stop.',
  },
  {
    name: 'anthropic',
    label: 'Anthropic',
    fields: [{ id: 'key', label: 'Anthropic key' }],
    what: 'Claude models for the listing check, Ask AI and Research. Checked when saved with a free request (it lists models; no tokens are used).',
    getKey: { href: 'https://console.anthropic.com/settings/keys', label: 'Get a key' },
    without: 'Pipelines set to an Anthropic model cannot run.',
  },
  {
    name: 'openai',
    label: 'OpenAI-compatible',
    fields: [{ id: 'key', label: 'OpenAI-compatible key' }],
    what: 'DeepSeek or another OpenAI-compatible service. Its address is set per pipeline under AI; the key is checked against it with a free request (its model list).',
    getKey: { href: 'https://platform.deepseek.com/api_keys', label: 'Get a DeepSeek key' },
    without: 'Pipelines set to an OpenAI-compatible model cannot run.',
  },
  {
    name: 'ebay',
    label: 'eBay',
    fields: [
      { id: 'appId', label: 'App ID (Client ID)' },
      { id: 'certId', label: 'Cert ID (Client Secret)' },
    ],
    what: 'eBay sold prices, as a reference. They are not counted in the estimate.',
    getKey: { href: 'https://developer.ebay.com/my/keys', label: 'Get keys' },
    without: 'eBay reference prices stop.',
  },
  {
    name: 'telegram',
    label: 'Telegram',
    fields: [
      { id: 'botToken', label: 'Telegram bot token' },
      { id: 'chatId', label: 'Telegram chat id (optional: the app can find it)', optional: true },
    ],
    what: 'Sends the same digest as the notifications to your phone. A message never carries a key. Leave the chat id empty and the app finds your chat when you send the bot a message.',
    getKey: { href: 'https://core.telegram.org/bots#how-do-i-create-a-bot', label: 'How to make a bot' },
    without: 'Messages stop going to Telegram.',
  },
  {
    name: 'amazonSeller',
    label: 'Amazon seller account',
    fields: [
      { id: 'clientId', label: 'Client id (LWA)' },
      { id: 'clientSecret', label: 'Client secret (LWA)' },
      { id: 'refreshToken', label: 'Refresh token' },
      { id: 'sellerId', label: 'Seller id (Merchant Token)' },
    ],
    what: "Read-only, from your own account: whether you may list each part, whether FBA takes it, and Amazon's fee estimate for you. Nothing is ever listed, changed or ordered. US marketplace only for now. Checked when saved: Amazon's sign-in, then one listing check.",
    how: <SellerHow />,
    without: 'Deals are no longer checked against your Amazon account.',
  },
];

/** The steps from docs/sp-api-notes-2026-11-25.md, in the app's words. */
function SellerHow() {
  return (
    <Fold id="keys-amazon-how" title="How to get these" sub>
      <ol className="key-how">
        <li>You need a professional seller account, signed in as its Primary User.</li>
        <li>
          In Seller Central open Apps and Services, then Develop Apps, and register as a private developer: data access private;
          roles Product Listing and Amazon Fulfillment (and Inventory and Order Tracking, for sales later). If Amazon opens a case,
          answer it within 5 days.
        </li>
        <li>Add an app client for yourself. Under its LWA credentials, View shows the client id and the client secret.</li>
        <li>Choose Authorize app for it: Amazon shows a refresh token. Each click makes a new one; earlier ones keep working.</li>
        <li>
          Your seller id is probably in Seller Central under Account Info, called Merchant Token. Amazon's developer pages do
          not say where it is shown, so if it is not there, ask Seller Support for your merchant token.
        </li>
      </ol>
    </Fold>
  );
}

/** His seller account's calls today against the app's own cap a day, in one line. */
function sellerUsageLine(u: NonNullable<ReturnType<typeof useApp>['state']>['seller']): string | null {
  if (!u) return null;
  const part = (op: keyof typeof u.used, noun: string) => `${u.used[op]} of ${u.caps[op]} ${noun}`;
  return `Today: ${part('restrictions', 'listing checks')}, ${part('eligibility', 'FBA checks')}, ${part('fees', 'fee estimates')}. Free; the app keeps under its own cap a day.`;
}

export function KeysPane() {
  return (
    <Pane>
      <p className="pane-lead">Keys stay in the agent on this {words.computer} and go only to their own service. This window can replace or remove one, and never reads it back.</p>
      {KEYS.map((k) => (
        <KeyRow key={k.name} def={k} />
      ))}
    </Pane>
  );
}

/** The eBay shape hints for one field, as one line (a hint, never a block). */
function hintsFor(id: string, value: string): ReactNode {
  const lines = ebayHints(id === 'appId' ? 'appId' : 'certId', value);
  return lines.length ? lines.join(' ') : undefined;
}

function KeyRow({ def }: { def: Def }) {
  const { state, refreshState } = useApp();
  // A Telegram bot saved without its chat counts as saved: the chat is chosen below it.
  const waitingForChat = def.name === 'telegram' && state?.keys.telegramWaitingForChat === true;
  const has = (state?.keys[def.name] ?? false) || waitingForChat;
  const ks = keyState(state, def.name);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const kc = useKeyCheck(def.name);
  // The key is saved either way; the agent's answer is what its own service said (a rejection is not an error of this form).
  const put = useAction(async (v: Record<string, string>) => kc.adopt(await (api.putKey as (n: KeyName, v: unknown) => Promise<C.KeyCheck>)(def.name, v)));
  const del = useAction(() => api.deleteKey(def.name));
  const complete = def.fields.every((f) => f.optional || (values[f.id] ?? '').trim());
  const open = editing || (!has && state !== null);

  const save = () => {
    if (!complete) return;
    void put.run(Object.fromEntries(def.fields.map((f) => [f.id, (values[f.id] ?? '').trim()]).filter(([, v]) => v !== ''))).then((ok) => {
      if (ok) {
        setValues({});
        setEditing(false);
        refreshState();
      }
    });
  };

  return (
    <Row label={def.label} align="start" help={def.what}>
      <div className="stack">
        <div className="key-status">
          {state === null ? null : has ? (
            ks.state === 'rejected' ? (
              <span className="key-rejected">
                <Glyph name="warning" size={12} />
                Saved, not accepted
              </span>
            ) : (
              <span className="key-saved">
                <Glyph name="check" size={12} />
                Saved
              </span>
            )
          ) : (
            <span className="muted">Not set</span>
          )}
          {has && !open && !removing ? (
            <span className="key-actions">
              <Button
                size="sm"
                onClick={() => {
                  kc.forget();
                  setEditing(true);
                }}
              >
                Replace
              </Button>
              <Button size="sm" variant="danger" onClick={() => setRemoving(true)}>
                Remove
              </Button>
            </span>
          ) : null}
          {def.getKey ? (
            <a className="key-get" href={def.getKey.href} target="_blank" rel="noopener noreferrer">
              {def.getKey.label}
            </a>
          ) : null}
        </div>
        {def.how ?? null}
        {def.name === 'amazonSeller' && has && sellerUsageLine(state?.seller) ? <p className="muted key-usage">{sellerUsageLine(state?.seller)}</p> : null}
        <KeyCheckLine name={def.name} checking={put.busy || kc.rechecking} now={kc.now} onCheckAgain={kc.recheck} canCheckAgain={!open && !removing} />
        {waitingForChat && !open && !removing ? <TelegramChatFinder /> : null}
        {removing ? (
          <ConfirmInline
            question={`Remove the ${def.label} key? ${def.without}`}
            confirmLabel="Remove"
            busy={del.busy}
            onCancel={() => setRemoving(false)}
            onConfirm={() =>
              void del.run().then((ok) => {
                if (ok) {
                  setRemoving(false);
                  refreshState();
                }
              })
            }
          />
        ) : null}
        {open ? (
          <form
            className="key-form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            {def.fields.map((f, i) => (
              <TextField
                key={f.id}
                label={<span className="sr-only">{f.label}</span>}
                type="password"
                autoComplete="off"
                spellCheck={false}
                mono
                width="md"
                placeholder={def.fields.length > 1 ? f.label : has ? 'Paste the new key' : 'Paste the key'}
                help={def.name === 'ebay' ? hintsFor(f.id, values[f.id] ?? '') : undefined}
                value={values[f.id] ?? ''}
                status={i === def.fields.length - 1 && put.error ? { tone: 'error', text: put.error } : null}
                onChange={(e) => {
                  setValues((cur) => ({ ...cur, [f.id]: e.target.value }));
                  put.clear();
                }}
              />
            ))}
            <span className="key-actions">
              <Button type="submit" size="sm" variant="primary" busy={put.busy} busyLabel="Saving…" disabled={!complete}>
                Save
              </Button>
              {has ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(false);
                    setValues({});
                    put.clear();
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </span>
          </form>
        ) : null}
        {del.error ? (
          <p className="field-status field-status-error" role="alert">
            {del.error}
          </p>
        ) : null}
      </div>
    </Row>
  );
}

/**
 * A Telegram bot saved without its chat: the private chats that wrote to it, each offered by name for one explicit choice
 * (anyone who finds the bot could write to it first, so none is chosen for him). Asks again every few seconds while it waits.
 */
function TelegramChatFinder() {
  const { refreshState } = useApp();
  const [res, reload] = useResource(() => api.telegramChat(), [], ['state']);
  const [test, setTest] = useState<{ ok: boolean; problem?: string } | null>(null);
  const use = useAction(async (chatId: string) => setTest((await api.useTelegramChat(chatId)).test));
  useEffect(() => {
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [reload]);
  const d = res.data;
  if (!d || d.state === 'no_bot' || d.state === 'chosen') {
    return test && !test.ok ? <p className="field-status field-status-error" role="alert">{test.problem ?? 'The test message did not go through.'}</p> : null;
  }
  const choose = (id: string) =>
    void use.run(id).then((ok) => {
      if (ok) {
        refreshState();
        reload();
      }
    });
  if (d.state === 'waiting') {
    return <p className="field-status" role="status">Open your bot in Telegram, press Start and send it any message. Its chat shows here for you to confirm.</p>;
  }
  return (
    <div className="stack">
      <p className="field-status" role="status">
        {d.chats.length === 1 ? 'This chat wrote to your bot. Use it only if it is yours.' : 'More than one chat wrote to your bot. Use only the one that is yours.'}
      </p>
      {d.chats.map((c) => (
        <span key={c.id} className="key-actions">
          <span>Use the chat with {c.name}?</span>
          <Button size="sm" variant="primary" busy={use.busy} busyLabel="Saving…" onClick={() => choose(c.id)}>
            Use this chat
          </Button>
        </span>
      ))}
      {use.error ? <p className="field-status field-status-error" role="alert">{use.error}</p> : null}
    </div>
  );
}
