import { useCallback, useState, type ReactNode } from 'react';
import type * as C from '@core/api/contract';
import { api, useAction, useApp } from '../api/hooks';
import type { KeyName } from '../api/types';
import { ebayHints } from '../lib/keyCheck';
import { Button } from './Button';
import { TextField } from './Fields';
import { KeyCheckLine, useKeyCheck } from './KeyCheck';
import { Notice } from './States';
import './SetupParts.css';

interface KeyFieldDef {
  id: string;
  label: string;
}

/** The hint, then the help, as one line; nothing when neither is there. */
function joinHelp(hint: string | null, help: ReactNode): ReactNode {
  if (!hint) return help;
  return help ? (
    <>
      {hint} {help}
    </>
  ) : (
    hint
  );
}

/** The eBay shape hint for one field (a hint, never a block), or null. */
function ebayHelp(name: KeyName, id: string, value: string): string | null {
  if (name !== 'ebay') return null;
  const lines = ebayHints(id === 'appId' ? 'appId' : 'certId', value);
  return lines.length ? lines.join(' ') : null;
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
  const kc = useKeyCheck(name);
  // The agent takes {key}, {appId, certId} or {botToken, chatId} by key name (core/src/api/contract.ts KeyValues). The key is
  // saved either way; the answer is what its own service said, shown under the field (a rejection is not an error of this form).
  const putKey = useCallback(async (n: KeyName, v: Record<string, string>) => kc.adopt(await (api.putKey as (n: KeyName, v: unknown) => Promise<C.KeyCheck>)(n, v)), [kc.adopt]);
  const put = useAction(putKey);
  const del = useAction(api.deleteKey);
  const complete = defs.every((d) => (values[d.id] ?? '').trim());
  const submit = () => {
    if (!complete) return;
    void put.run(name, Object.fromEntries(defs.map((d) => [d.id, (values[d.id] ?? '').trim()]))).then((ok) => {
      if (ok) {
        setValues({});
        refreshState();
      }
    });
  };
  const shown = put.error ? { tone: 'error' as const, text: put.error } : null;
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
            put.clear();
          }}
          help={joinHelp(ebayHelp(name, d.id, values[d.id] ?? ''), i === defs.length - 1 ? help : undefined)}
          status={i === defs.length - 1 ? shown : null}
        />
      ))}
      <KeyCheckLine name={name} checking={put.busy || kc.rechecking} now={kc.now} onCheckAgain={kc.recheck} />
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
                  kc.forget();
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
