import { useState, type ReactNode } from 'react';
import { api, useAction, useApp } from '../../api/hooks';
import type { KeyName } from '../../api/types';
import { Button } from '../../components/Button';
import { TextField } from '../../components/Fields';
import { Glyph } from '../../components/Glyph';
import { ConfirmInline } from '../../components/States';
import { Pane, Row } from './form';

interface Def {
  name: KeyName;
  label: string;
  /** The fields, with the names the agent takes: one `key`, or the pair. */
  fields: { id: string; label: string }[];
  what: ReactNode;
  getKey: { href: string; label: string };
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
    what: 'Claude models for the listing check, Ask AI and Research. Not checked when saved: a check costs money.',
    getKey: { href: 'https://console.anthropic.com/settings/keys', label: 'Get a key' },
    without: 'Pipelines set to an Anthropic model cannot run.',
  },
  {
    name: 'openai',
    label: 'OpenAI-compatible',
    fields: [{ id: 'key', label: 'OpenAI-compatible key' }],
    what: 'DeepSeek or another OpenAI-compatible service. Its address is set per pipeline under AI.',
    getKey: { href: 'https://platform.deepseek.com/api_keys', label: 'Get a DeepSeek key' },
    without: 'Pipelines set to an OpenAI-compatible model cannot run.',
  },
  {
    name: 'ebay',
    label: 'eBay',
    fields: [
      { id: 'appId', label: 'eBay App ID' },
      { id: 'certId', label: 'eBay Cert ID' },
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
      { id: 'chatId', label: 'Telegram chat id' },
    ],
    what: 'Sends the same digest as the notifications to your phone. A message never carries a key.',
    getKey: { href: 'https://core.telegram.org/bots#how-do-i-create-a-bot', label: 'How to make a bot' },
    without: 'Messages stop going to Telegram.',
  },
];

export function KeysPane() {
  return (
    <Pane>
      <p className="pane-lead">Keys stay in the agent on this Mac and go only to their own service. This window can replace or remove one, and never reads it back.</p>
      {KEYS.map((k) => (
        <KeyRow key={k.name} def={k} />
      ))}
    </Pane>
  );
}

function KeyRow({ def }: { def: Def }) {
  const { state, refreshState } = useApp();
  const has = state?.keys[def.name] ?? false;
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const put = useAction((v: Record<string, string>) => (api.putKey as (n: KeyName, v: unknown) => Promise<void>)(def.name, v));
  const del = useAction(() => api.deleteKey(def.name));
  const complete = def.fields.every((f) => (values[f.id] ?? '').trim());
  const open = editing || (!has && state !== null);

  const save = () => {
    if (!complete) return;
    void put.run(Object.fromEntries(def.fields.map((f) => [f.id, (values[f.id] ?? '').trim()]))).then((ok) => {
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
            <span className="key-saved">
              <Glyph name="check" size={12} />
              Saved
            </span>
          ) : (
            <span className="muted">Not set</span>
          )}
          {has && !open && !removing ? (
            <span className="key-actions">
              <Button size="sm" onClick={() => setEditing(true)}>
                Replace
              </Button>
              <Button size="sm" variant="danger" onClick={() => setRemoving(true)}>
                Remove
              </Button>
            </span>
          ) : null}
          <a className="key-get" href={def.getKey.href} target="_blank" rel="noopener noreferrer">
            {def.getKey.label}
          </a>
        </div>
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
