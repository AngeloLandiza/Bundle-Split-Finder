import { useCallback, useState, type ReactNode } from 'react';
import type * as C from '@core/api/contract';
import { api, useAction, useApp } from '../api/hooks';
import type { KeyName } from '../api/types';
import { Button } from './Button';
import { TextField } from './Fields';
import { Notice } from './States';
import './SetupParts.css';

interface KeyFieldDef {
  id: string;
  label: string;
}

/**
 * A write-only key: the fields are always empty; "Saved" says a key is on file. Most keys are one string; eBay and
 * Telegram are two, and are saved together (the agent holds them as a pair).
 */
export function KeyField({ name, label, help, fields }: { name: KeyName; label: string; help?: ReactNode; fields?: KeyFieldDef[] }) {
  const { state, refreshState } = useApp();
  const defs: KeyFieldDef[] = fields ?? [{ id: 'key', label }];
  const has = state?.keys[name] ?? false;
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  // The agent takes {key}, {appId, certId} or {botToken, chatId} by key name (core/src/api/contract.ts KeyValues).
  const putKey = useCallback((n: KeyName, v: Record<string, string>) => (api.putKey as (n: KeyName, v: unknown) => Promise<void>)(n, v), []);
  const put = useAction(putKey);
  const del = useAction(api.deleteKey);
  const complete = defs.every((d) => (values[d.id] ?? '').trim());
  const submit = () => {
    if (!complete) return;
    void put.run(name, Object.fromEntries(defs.map((d) => [d.id, (values[d.id] ?? '').trim()]))).then((ok) => {
      if (ok) {
        setValues({});
        setStatus({ tone: 'ok', text: 'Saved' });
        refreshState();
      }
    });
  };
  const shown = put.error ? { tone: 'error' as const, text: put.error } : (status ?? (has ? { tone: 'ok' as const, text: 'Saved' } : null));
  return (
    <form
      className="keyfield"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {defs.map((d, i) => (
        <TextField
          key={d.id}
          label={d.label}
          type="password"
          autoComplete="off"
          spellCheck={false}
          mono
          value={values[d.id] ?? ''}
          placeholder={has ? 'Paste a new one to replace it' : 'Paste it here'}
          onChange={(e) => {
            setValues((cur) => ({ ...cur, [d.id]: e.target.value }));
            setStatus(null);
            put.clear();
          }}
          help={i === defs.length - 1 ? help : undefined}
          status={i === defs.length - 1 ? shown : null}
        />
      ))}
      <div className="keyfield-actions">
        <Button type="submit" size="sm" busy={put.busy} busyLabel="Saving…" disabled={!complete}>
          {has ? 'Replace' : 'Save'}
        </Button>
        {has ? (
          <Button
            variant="quiet"
            size="sm"
            busy={del.busy}
            onClick={() =>
              void del.run(name).then((ok) => {
                if (ok) {
                  setStatus(null);
                  refreshState();
                }
              })
            }
          >
            Remove
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Unpacks the bundled Chrome helper into its folder (POST /api/setup/install-extension) and says where, in one sentence.
 * Used by the welcome sheet's Connect Chrome step and by Preferences > Chrome.
 */
export function InstallHelper() {
  const [done, setDone] = useState<C.InstallExtensionResponse | null>(null);
  const install = useAction(async () => {
    setDone(null);
    setDone(await api.installExtension());
  });
  return (
    <div className="install-helper">
      <Button size="sm" busy={install.busy} busyLabel="Installing…" onClick={() => void install.run()}>
        Install the Chrome helper
      </Button>
      {install.error ? (
        <Notice tone="attention" title="The helper was not installed.">
          {install.error}
        </Notice>
      ) : done ? (
        <Notice>{`Unpacked to ${done.extensionDir}. In Chrome, open chrome://extensions, turn on Developer mode, click Load unpacked and choose this folder.`}</Notice>
      ) : null}
    </div>
  );
}
