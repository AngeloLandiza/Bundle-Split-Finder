import { useRef, useState } from 'react';
import type { ExtensionSettings, SettingsField } from '@core/settings';
import type { AppState } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { Confirm, NumberField, Section } from './fields';

type Problems = Partial<Record<SettingsField, string>>;
type Result = { ok: true; text: string } | { ok: false; message: string };

const DISCOVERY_LABELS: Record<ExtensionSettings['discoveryMode'], string> = {
  auto: 'Balance discovery and tracking automatically',
  discovery_heavy: 'Favour finding new listings',
  tracking_heavy: 'Favour refreshing known prices',
};

const DEPTH_LABELS: Record<ExtensionSettings['trackingDepth'], string> = {
  price_only: 'Amazon price only (1 token a part)',
  price_and_rank: 'Price and sales rank (1 token a part)',
  full: 'Price, rank, and offers (up to 13 tokens a part)',
};

export function KeepaSection({
  api,
  state,
  draft,
  problems,
  onChange,
  onCommit,
}: {
  api: WorkerApi;
  state: AppState;
  draft: ExtensionSettings;
  problems: Problems;
  onChange(patch: Partial<ExtensionSettings>, commit?: boolean): void;
  onCommit(): void;
}) {
  const keyRef = useRef<HTMLInputElement>(null);
  const [hasText, setHasText] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyResult, setKeyResult] = useState<Result | null>(null);
  const hasKey = state.keepa?.hasKeepaKey === true;

  async function saveKey() {
    setSaving(true);
    setKeyResult(null);
    try {
      const reply = await api.send<null>({ type: 'saveKeepaKey', apiKey: (keyRef.current?.value ?? '').trim() });
      if (reply.ok) {
        setKeyResult({ ok: true, text: 'Keepa key saved in this browser. Refreshes may use Keepa tokens instead of SerpApi searches.' });
        if (keyRef.current) keyRef.current.value = '';
        setHasText(false);
      } else {
        setKeyResult({ ok: false, message: reply.error });
      }
    } catch {
      setKeyResult({ ok: false, message: UNREACHABLE });
    } finally {
      setSaving(false);
    }
  }

  async function forgetKey() {
    try {
      const reply = await api.send<null>({ type: 'forgetKeepaKey' });
      setKeyResult(reply.ok ? null : { ok: false, message: reply.error });
      if (reply.ok && keyRef.current) keyRef.current.value = '';
    } catch {
      setKeyResult({ ok: false, message: UNREACHABLE });
    }
  }

  const shown = keyResult ?? (hasKey ? { ok: true as const, text: 'Keepa key saved.' } : null);

  return (
    <Section
      title="Keepa"
      help="Optional. Amazon refreshes and identify steps can use your Keepa token allowance instead of SerpApi searches when a key is saved."
    >
      <div className="field">
        <label htmlFor="keepa-key">Keepa API key</label>
        <div className="row">
          <input
            id="keepa-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="input figure key-input"
            placeholder={hasKey ? 'Key saved' : ''}
            ref={keyRef}
            onChange={(e) => setHasText(e.target.value.trim() !== '')}
          />
          <button type="button" className="btn" disabled={saving || !hasText} onClick={saveKey}>
            {saving ? 'Saving' : 'Save key'}
          </button>
          {hasKey ? (
            <Confirm label="Remove Keepa key" question="Remove the saved Keepa key from this browser?" yes="Yes, remove Keepa key" danger onYes={forgetKey} />
          ) : null}
        </div>
        <div className="key-result" role="status" data-testid="keepa-key-result">
          {shown ? (shown.ok ? <span>{shown.text}</span> : <span className="field-error">{shown.message}</span>) : null}
        </div>
        <a href="https://keepa.com/#!api" className="link" target="_blank" rel="noreferrer">
          Get an API key from keepa.com
        </a>
      </div>

      <label className="choice">
        <input
          type="checkbox"
          checked={draft.amazonRefreshViaKeepa}
          onChange={() => onChange({ amazonRefreshViaKeepa: !draft.amazonRefreshViaKeepa }, true)}
        />
        Use Keepa for Amazon refreshes and verify when a key is saved
      </label>

      <div className="row row--wide">
        <NumberField
          id="keepa-tokens"
          label="Keepa tokens per scan, at most"
          width={120}
          min={0}
          max={250}
          value={draft.keepaTokensPerScan}
          invalid={Boolean(problems.keepaTokensPerScan)}
          error={problems.keepaTokensPerScan}
          onCommit={onCommit}
          onChange={(v) => onChange({ keepaTokensPerScan: v })}
        />
        <NumberField
          id="keepa-reserve"
          label="Always keep in Keepa reserve"
          width={120}
          min={0}
          max={250}
          value={draft.keepaReserve}
          invalid={Boolean(problems.keepaReserve)}
          error={problems.keepaReserve}
          onCommit={onCommit}
          onChange={(v) => onChange({ keepaReserve: v })}
        />
      </div>

      <fieldset className="group">
        <legend>Discovery vs tracking</legend>
        {(Object.keys(DISCOVERY_LABELS) as ExtensionSettings['discoveryMode'][]).map((mode) => (
          <label key={mode} className="choice">
            <input
              type="radio"
              name="discovery-mode"
              checked={draft.discoveryMode === mode}
              onChange={() => onChange({ discoveryMode: mode }, true)}
            />
            {DISCOVERY_LABELS[mode]}
          </label>
        ))}
      </fieldset>

      {draft.discoveryMode === 'auto' ? (
        <NumberField
          id="keepa-discovery-share"
          label="Discovery share cap in auto mode, %"
          width={120}
          min={10}
          max={90}
          value={draft.keepaDiscoveryShare}
          invalid={Boolean(problems.keepaDiscoveryShare)}
          error={problems.keepaDiscoveryShare}
          onCommit={onCommit}
          onChange={(v) => onChange({ keepaDiscoveryShare: v })}
        />
      ) : null}

      <fieldset className="group">
        <legend>Tracking depth on Keepa product pulls</legend>
        {(Object.keys(DEPTH_LABELS) as ExtensionSettings['trackingDepth'][]).map((depth) => (
          <label key={depth} className="choice">
            <input
              type="radio"
              name="tracking-depth"
              checked={draft.trackingDepth === depth}
              onChange={() => onChange({ trackingDepth: depth }, true)}
            />
            {DEPTH_LABELS[depth]}
          </label>
        ))}
      </fieldset>
    </Section>
  );
}