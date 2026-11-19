import { useRef, useState } from 'react';
import { CLAUDE_JUDGE_MODELS } from '@core/judge/claude';
import { MAX_LISTINGS_JUDGED_PER_SCAN } from '@core/scan/ebayPass';
import { DEFAULT_EBAY_SETTINGS, ebaySettingsProblem, estimatedJudgeCost } from '@core/settings';
import type { AppState } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { Confirm, NumberField, Section } from './fields';

type Result = { ok: true; text: string } | { ok: false; message: string };

const MODEL_NAMES: Record<string, { name: string; note: string }> = {
  'claude-haiku-5-5': { name: 'Claude Haiku 5.5', note: 'the cheapest, and the starting choice' },
  'claude-opus-5-5': { name: 'Claude Opus 5.5', note: 'slower and costs much more per listing' },
};

const dollars = (n: number): string => (n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="key-check">
      <path d="M3.5 8.5l3 3L12.5 5" />
    </svg>
  );
}

function ResultLine({ result, testId }: { result: Result | null; testId: string }) {
  return (
    <div className="key-result" role="status" data-testid={testId}>
      {result === null ? null : result.ok ? (
        <>
          <Check />
          <span>{result.text}</span>
        </>
      ) : (
        <span className="field-error">{result.message}</span>
      )}
    </div>
  );
}

/** eBay's App ID and Cert ID. Saved only when eBay gives a token for them; the fields are uncontrolled, like the SerpApi key's. */
export function EbayKeysSection({ api, state }: { api: WorkerApi; state: AppState }) {
  const appRef = useRef<HTMLInputElement>(null);
  const certRef = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState({ app: false, cert: false });
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const has = state.ebay?.hasEbayKeys === true;

  const clear = () => {
    if (appRef.current) appRef.current.value = '';
    if (certRef.current) certRef.current.value = '';
    setFilled({ app: false, cert: false });
  };

  async function check() {
    setChecking(true);
    setResult(null);
    try {
      const reply = await api.send<null>({ type: 'saveEbayKeys', appId: (appRef.current?.value ?? '').trim(), certId: (certRef.current?.value ?? '').trim() });
      if (reply.ok) {
        setResult({ ok: true, text: 'Keys work. eBay gave a token, and the keys are saved in this browser.' });
        clear();
      } else {
        setResult({ ok: false, message: reply.error });
      }
    } catch {
      setResult({ ok: false, message: UNREACHABLE });
    } finally {
      setChecking(false);
    }
  }

  async function forget() {
    try {
      const reply = await api.send<null>({ type: 'forgetEbayKeys' });
      setResult(reply.ok ? null : { ok: false, message: reply.error });
      if (reply.ok) clear();
    } catch {
      setResult({ ok: false, message: UNREACHABLE });
    }
  }

  const shown = result ?? (has ? { ok: true as const, text: 'eBay keys saved. They are checked when a scan uses them.' } : null);

  return (
    <Section
      title="eBay reference values"
      help="What New units of each part sell for on eBay, shown beside a part's other prices as a reference. It is not counted in any estimate. It uses your own eBay developer keys, stored only in this browser."
    >
      <div className="grid">
        <div className="field">
          <label htmlFor="ebay-app">eBay App ID</label>
          <input
            id="ebay-app"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="input figure key-input"
            placeholder={has ? 'Saved' : ''}
            ref={appRef}
            onChange={(e) => setFilled((f) => ({ ...f, app: e.target.value.trim() !== '' }))}
          />
        </div>
        <div className="field">
          <label htmlFor="ebay-cert">eBay Cert ID</label>
          <input
            id="ebay-cert"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="input figure key-input"
            placeholder={has ? 'Saved' : ''}
            ref={certRef}
            onChange={(e) => setFilled((f) => ({ ...f, cert: e.target.value.trim() !== '' }))}
          />
        </div>
      </div>
      <div className="row">
        <button type="button" className="btn" disabled={checking || !filled.app || !filled.cert} onClick={check}>
          {checking ? 'Checking' : 'Check eBay keys'}
        </button>
        {has ? <Confirm label="Remove eBay keys" question="Remove the saved eBay keys from this browser?" yes="Yes, remove keys" danger onYes={forget} /> : null}
      </div>
      <ResultLine result={shown} testId="ebay-key-result" />
      <a href="https://developer.ebay.com/my/keys" className="link" target="_blank" rel="noreferrer">
        Get production keys at developer.ebay.com
      </a>
    </Section>
  );
}

/** The Anthropic key, the model that checks each eBay listing, and how many listings it may check in one scan. */
export function ListingCheckSection({ api, state }: { api: WorkerApi; state: AppState }) {
  const keyRef = useRef<HTMLInputElement>(null);
  const [hasText, setHasText] = useState(false);
  const [keyResult, setKeyResult] = useState<Result | null>(null);
  const [saving, setSaving] = useState(false);

  const saved = state.ebay ?? { hasEbayKeys: false, hasAnthropicKey: false, ...DEFAULT_EBAY_SETTINGS };
  const [model, setModel] = useState(saved.judgeModel);
  const [limit, setLimit] = useState(saved.listingsJudgedPerScan);
  const [settingsResult, setSettingsResult] = useState<Result | null>(null);
  const problem = ebaySettingsProblem({ judgeModel: model, listingsJudgedPerScan: limit });
  const cost = problem === null ? estimatedJudgeCost(model, limit) : null;

  async function saveKey() {
    setSaving(true);
    setKeyResult(null);
    try {
      const reply = await api.send<null>({ type: 'saveAnthropicKey', apiKey: (keyRef.current?.value ?? '').trim() });
      if (reply.ok) {
        setKeyResult({ ok: true, text: 'Key saved in this browser. It is used, and so checked, when a scan judges a listing.' });
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
      const reply = await api.send<null>({ type: 'forgetAnthropicKey' });
      setKeyResult(reply.ok ? null : { ok: false, message: reply.error });
      if (reply.ok && keyRef.current) keyRef.current.value = '';
    } catch {
      setKeyResult({ ok: false, message: UNREACHABLE });
    }
  }

  async function saveSettings(next: { judgeModel: string; listingsJudgedPerScan: number }) {
    if (ebaySettingsProblem(next) !== null) return;
    setSettingsResult(null);
    try {
      const reply = await api.send<null>({ type: 'saveEbaySettings', ...next });
      setSettingsResult(reply.ok ? { ok: true, text: 'Saved.' } : { ok: false, message: reply.error });
    } catch {
      setSettingsResult({ ok: false, message: UNREACHABLE });
    }
  }

  const shownKey = keyResult ?? (saved.hasAnthropicKey ? { ok: true as const, text: 'Anthropic key saved.' } : null);

  return (
    <Section
      title="Listing check"
      help="A model reads each eBay listing to check it is exactly the part, New, with the same contents. It uses your own Anthropic key, so the calls are billed to your Anthropic account."
    >
      <div className="field">
        <label htmlFor="anthropic-key">Anthropic API key</label>
        <div className="row">
          <input
            id="anthropic-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="input figure key-input"
            placeholder={saved.hasAnthropicKey ? 'Key saved' : ''}
            ref={keyRef}
            onChange={(e) => setHasText(e.target.value.trim() !== '')}
          />
          <button type="button" className="btn" disabled={saving || !hasText} onClick={saveKey}>
            {saving ? 'Adding' : 'Add key'}
          </button>
          {saved.hasAnthropicKey ? <Confirm label="Remove key" question="Remove the saved Anthropic key from this browser?" yes="Yes, remove key" danger onYes={forgetKey} /> : null}
        </div>
      </div>
      <ResultLine result={shownKey} testId="anthropic-key-result" />

      <fieldset className="group">
        <legend>Model that reads the listings</legend>
        {CLAUDE_JUDGE_MODELS.map((id) => (
          <label className="choice" key={id}>
            <input
              type="radio"
              name="judge-model"
              checked={model === id}
              onChange={() => {
                setModel(id);
                void saveSettings({ judgeModel: id, listingsJudgedPerScan: limit });
              }}
            />
            <span>
              {MODEL_NAMES[id]?.name ?? id} <span className="hint">{MODEL_NAMES[id]?.note ?? ''}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div>
        <NumberField
          id="ebay-limit"
          label="eBay listings judged per scan"
          width={120}
          min={1}
          max={MAX_LISTINGS_JUDGED_PER_SCAN}
          step="1"
          value={limit}
          invalid={problem !== null && problem !== 'Choose one of the models offered.'}
          error={problem !== null && problem !== 'Choose one of the models offered.' ? problem : undefined}
          onChange={setLimit}
          onCommit={() => void saveSettings({ judgeModel: model, listingsJudgedPerScan: limit })}
          after={<span className="hint">the most the model is asked about in one scan</span>}
        />
      </div>
      {cost !== null ? (
        <p className="note" data-testid="ebay-cost">
          Estimated cost: up to <span className="figure small">{dollars(cost)}</span> a scan. An estimate from the model&apos;s published rates; your Anthropic bill is what counts. A listing is judged once, and kept, so a repeat scan costs less.
        </p>
      ) : null}
      <p className="note" role="status" data-testid="ebay-settings-status">
        {settingsResult === null ? '' : settingsResult.ok ? settingsResult.text : settingsResult.message}
      </p>
    </Section>
  );
}
