// Nov 25, key stacking: SerpApi's and Keepa's saved keys in Settings › Keys. With one key the row stays as it was (Saved,
// Replace, Remove, its check) and only a quiet "Add another key" is new; with two or more, one line per key: its label, when
// it was added, its own check, and Rename, Check again and Remove. A value is never shown again after saving.

import { useState } from 'react';
import { api, useAction, useApp } from '../../api/hooks';
import type { KeyCheck, KeyEntryView, StackedKeyName } from '../../api/types';
import { Button } from '../../components/Button';
import { TextField } from '../../components/Fields';
import { Glyph } from '../../components/Glyph';
import { ConfirmInline, Spinner } from '../../components/States';
import { ADD_ANOTHER_HELP, addedWords, entriesOf, entryCheckWords, removeEntryQuestion } from '../../lib/keyEntries';

const SERVICE: Record<StackedKeyName, string> = { serpapi: 'SerpApi', keepa: 'Keepa' };

/** One line per saved key, shown when a service holds two or more. */
export function KeyEntryList({ name }: { name: StackedKeyName }) {
  const { state } = useApp();
  const entries = entriesOf(state, name);
  return (
    <ul className="key-entries" aria-label={`${SERVICE[name]} keys`}>
      {entries.map((e) => (
        <KeyEntryLine key={e.id} name={name} entry={e} />
      ))}
    </ul>
  );
}

function KeyEntryLine({ name, entry }: { name: StackedKeyName; entry: KeyEntryView }) {
  const { refreshState } = useApp();
  const [mode, setMode] = useState<'view' | 'rename' | 'remove'>('view');
  const [label, setLabel] = useState(entry.label);
  const [answer, setAnswer] = useState<KeyCheck | null>(null);
  const rename = useAction(() => api.renameKey(name, entry.id, label.trim()));
  const remove = useAction(() => api.removeKeyEntry(name, entry.id));
  const check = useAction(async () => setAnswer(await api.checkKeyEntry(name, entry.id)));
  const words = entryCheckWords(name, entry);
  // A Check again answer the agent could not get (no answer from the service) is said here once; the stored verdict stays.
  const unreached = answer && !answer.ok && answer.kind !== 'rejected' ? answer.problem : null;
  const added = addedWords(entry.addedAt);

  return (
    <li className="key-entry">
      <div className="key-status">
        <span className="key-entry-label">{entry.label}</span>
        {added ? <span className="muted key-entry-added">{added}</span> : null}
        {mode === 'view' ? (
          <span className="key-actions">
            <Button size="sm" onClick={() => setMode('rename')}>
              Rename
            </Button>
            <Button size="sm" busy={check.busy} busyLabel="Checking…" onClick={() => void check.run().then(refreshState)}>
              Check again
            </Button>
            <Button size="sm" variant="danger" onClick={() => setMode('remove')}>
              Remove
            </Button>
          </span>
        ) : null}
      </div>
      <p className={`key-check key-check-${check.busy ? 'checking' : words.tone === 'unknown' ? 'none' : words.tone}`} role={words.tone === 'rejected' ? 'alert' : 'status'}>
        {check.busy ? <Spinner size={12} /> : words.tone === 'works' ? <Glyph name="check" size={12} /> : words.tone === 'rejected' ? <Glyph name="warning" size={12} /> : null}
        <span className="key-check-text">{check.busy ? `Checking with ${SERVICE[name]}…` : words.text}</span>
      </p>
      {unreached ? <p className="key-check key-check-unreached">{unreached}</p> : null}
      {mode === 'rename' ? (
        <form
          className="key-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (!label.trim()) return;
            void rename.run().then((ok) => {
              if (ok) {
                setMode('view');
                refreshState();
              }
            });
          }}
        >
          <TextField
            label={<span className="sr-only">Name of this key</span>}
            width="md"
            value={label}
            maxLength={40}
            status={rename.error ? { tone: 'error', text: rename.error } : null}
            onChange={(ev) => {
              setLabel(ev.target.value);
              rename.clear();
            }}
          />
          <span className="key-actions">
            <Button type="submit" size="sm" variant="primary" busy={rename.busy} busyLabel="Saving…" disabled={!label.trim()}>
              Save
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setLabel(entry.label);
                setMode('view');
                rename.clear();
              }}
            >
              Cancel
            </Button>
          </span>
        </form>
      ) : null}
      {mode === 'remove' ? (
        <ConfirmInline
          question={removeEntryQuestion(name, entry.label)}
          confirmLabel="Remove"
          busy={remove.busy}
          onCancel={() => setMode('view')}
          onConfirm={() =>
            void remove.run().then((ok) => {
              if (ok) {
                setMode('view');
                refreshState();
              }
            })
          }
        />
      ) : null}
      {remove.error ? (
        <p className="field-status field-status-error" role="alert">
          {remove.error}
        </p>
      ) : null}
    </li>
  );
}

/** "Add another key": a quiet button, then the field, an optional name and what the key does to the totals. */
export function AddAnotherKey({ name }: { name: StackedKeyName }) {
  const { refreshState } = useApp();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [answer, setAnswer] = useState<KeyCheck | null>(null);
  const add = useAction(async () => setAnswer((await api.addKey(name, value.trim(), label.trim() || undefined)).check));

  if (!open) {
    return (
      <div className="stack key-add">
        <span className="key-actions">
          <Button
            size="sm"
            onClick={() => {
              setOpen(true);
              setAnswer(null);
            }}
          >
            Add another key
          </Button>
        </span>
        {answer ? (
          <p className={`key-check key-check-${answer.ok ? 'works' : answer.kind === 'rejected' ? 'rejected' : 'unreached'}`} role="status">
            {answer.ok ? <Glyph name="check" size={12} /> : <Glyph name="warning" size={12} />}
            <span className="key-check-text">{answer.ok ? `Saved and accepted${answer.detail ? `, ${answer.detail}` : ''}.` : answer.problem}</span>
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className="key-form key-add"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!value.trim()) return;
        void add.run().then((ok) => {
          if (ok) {
            setValue('');
            setLabel('');
            setOpen(false);
            refreshState();
          }
        });
      }}
    >
      <p className="muted key-add-help">{ADD_ANOTHER_HELP[name]}</p>
      <TextField
        label={<span className="sr-only">{`Another ${SERVICE[name]} key`}</span>}
        type="password"
        autoComplete="off"
        spellCheck={false}
        mono
        width="md"
        placeholder="Paste the key"
        value={value}
        onChange={(ev) => {
          setValue(ev.target.value);
          add.clear();
        }}
      />
      <TextField
        label={<span className="sr-only">Name (optional)</span>}
        width="md"
        maxLength={40}
        placeholder="Name (optional), for example Partner"
        value={label}
        status={add.error ? { tone: 'error', text: add.error } : null}
        onChange={(ev) => {
          setLabel(ev.target.value);
          add.clear();
        }}
      />
      <span className="key-actions">
        <Button type="submit" size="sm" variant="primary" busy={add.busy} busyLabel="Saving…" disabled={!value.trim()}>
          Save
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setOpen(false);
            setValue('');
            setLabel('');
            add.clear();
          }}
        >
          Cancel
        </Button>
      </span>
    </form>
  );
}
