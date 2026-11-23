import { useRef, useState } from 'react';
import type { AppState } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { Confirm, Section } from './fields';

type Result = { ok: true; text: string } | { ok: false; message: string };

export function RelaySection({ api, state }: { api: WorkerApi; state: AppState }) {
  const urlRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [keyResult, setKeyResult] = useState<Result | null>(null);
  const hasConfig = state.relay?.hasRelayConfig === true;
  const [ready, setReady] = useState(false);
  const touch = () => {
    const u = urlRef.current?.value.trim() ?? '';
    const s = secretRef.current?.value.trim() ?? '';
    setReady(u !== '' && s !== '');
  };

  async function save() {
    setSaving(true);
    setKeyResult(null);
    try {
      const reply = await api.send<null>({
        type: 'saveRelayConfig',
        url: (urlRef.current?.value ?? '').trim(),
        secret: (secretRef.current?.value ?? '').trim(),
      });
      if (reply.ok) {
        setKeyResult({
          ok: true,
          text: 'Relay saved. Each finished scan POSTs a signed digest to that URL when alerts ran.',
        });
        if (urlRef.current) urlRef.current.value = '';
        if (secretRef.current) secretRef.current.value = '';
      } else {
        setKeyResult({ ok: false, message: reply.error });
      }
    } catch {
      setKeyResult({ ok: false, message: UNREACHABLE });
    } finally {
      setSaving(false);
    }
  }

  async function forget() {
    try {
      const reply = await api.send<null>({ type: 'forgetRelayConfig' });
      setKeyResult(reply.ok ? null : { ok: false, message: reply.error });
    } catch {
      setKeyResult({ ok: false, message: UNREACHABLE });
    }
  }

  const shown = keyResult ?? (hasConfig ? { ok: true as const, text: 'Relay endpoint saved.' } : null);

  return (
    <Section
      title="Outbound relay"
      help="Optional. After each scan, the extension POSTs a small JSON digest to your endpoint, signed with HMAC-SHA256 in the X-Relay-Signature header. Use npm run relay:dev locally to test."
    >
      <div className="field">
        <label htmlFor="relay-url">Webhook URL</label>
        <input
          id="relay-url"
          type="url"
          autoComplete="off"
          spellCheck={false}
          className="input"
          placeholder={hasConfig ? 'Saved — enter a new URL to replace' : 'https://…'}
          ref={urlRef}
          onChange={touch}
        />
      </div>
      <div className="field">
        <label htmlFor="relay-secret">Shared secret</label>
        <div className="row">
          <input
            id="relay-secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="input key-input"
            placeholder={hasConfig ? 'Saved — enter a new secret to replace' : ''}
            ref={secretRef}
            onChange={touch}
          />
          <button type="button" className="btn" disabled={saving || !ready} onClick={save}>
            {saving ? 'Saving' : 'Save relay'}
          </button>
          {hasConfig ? (
            <Confirm label="Remove relay" question="Stop posting scan digests to the saved URL?" yes="Yes, remove relay" danger onYes={forget} />
          ) : null}
        </div>
        <div className="key-result" role="status">
          {shown ? (shown.ok ? <span>{shown.text}</span> : <span className="field-error">{shown.message}</span>) : null}
        </div>
      </div>
    </Section>
  );
}