import { useRef, useState } from 'react';
import type { AccountInfo } from '@core/serpapi/budget';
import type { AppState } from '../../lib/messages';
import { Confirm, Section } from './fields';
import type { WorkerApi } from './worker';

type Result = { ok: true; account: AccountInfo } | { ok: false; message: string };

const UNREACHABLE = 'Could not reach the extension. Reload this page and try again.';
const n = (v: number): string => v.toLocaleString('en-US');

function KeyWorks({ account }: { account: AccountInfo }) {
  return (
    <>
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="key-check"
      >
        <path d="M3.5 8.5l3 3L12.5 5" />
      </svg>
      <span>
        <strong>Key works.</strong> {account.planName} · <span className="figure small">{n(account.totalSearchesLeft)}</span> of{' '}
        <span className="figure small">{n(account.searchesPerMonth)}</span> searches left this month ·{' '}
        <span className="figure small">{n(account.rateLimitPerHour)}</span> an hour
      </span>
    </>
  );
}

export function KeySection({ api, state }: { api: WorkerApi; state: AppState }) {
  // Uncontrolled on purpose: React would copy the typed key into the DOM as a value attribute.
  const keyRef = useRef<HTMLInputElement>(null);
  const [hasText, setHasText] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function check() {
    setChecking(true);
    setResult(null);
    try {
      const reply = await api.send<AccountInfo>({ type: 'checkKey', apiKey: (keyRef.current?.value ?? '').trim() });
      if (reply.ok) {
        setResult({ ok: true, account: reply.data });
        clearField();
      } else {
        setResult({ ok: false, message: reply.error });
      }
    } catch {
      setResult({ ok: false, message: 'Split Finder could not be reached. Reload this page and try again.' });
    } finally {
      setChecking(false);
    }
  }

  function clearField() {
    if (keyRef.current) keyRef.current.value = '';
    setHasText(false);
  }

  async function forget() {
    try {
      const reply = await api.send<unknown>({ type: 'forgetKey' });
      setResult(reply.ok ? null : { ok: false, message: reply.error });
      if (reply.ok) clearField();
    } catch {
      setResult({ ok: false, message: UNREACHABLE });
    }
  }

  const shown: Result | null =
    result ??
    (state.hasKey && state.account
      ? { ok: true, account: state.account }
      : state.problem
        ? { ok: false, message: state.problem }
        : null);

  return (
    <Section
      title="SerpApi key"
      help="Split Finder gets Home Depot and Amazon data through your own SerpApi account. The key is stored only in this browser."
    >
      <label htmlFor="key" className="label">
        API key
      </label>
      <div className="row">
        <input
          id="key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="input figure key-input"
          placeholder={state.hasKey ? 'Key saved' : ''}
          ref={keyRef}
          onChange={(e) => setHasText(e.target.value.trim() !== '')}
        />
        <button type="button" className="btn" disabled={checking || !hasText} onClick={check}>
          {checking ? 'Checking' : 'Check key'}
        </button>
        {state.hasKey ? (
          <Confirm
            label="Remove key"
            question="Remove the saved key from this browser?"
            yes="Yes, remove key"
            danger
            onYes={forget}
          />
        ) : null}
      </div>
      <div className="key-result" role="status" data-testid="key-result">
        {shown ? shown.ok ? <KeyWorks account={shown.account} /> : shown.message : null}
      </div>
      <a href="https://serpapi.com" className="link" target="_blank" rel="noreferrer">
        Get a free key at serpapi.com
      </a>
    </Section>
  );
}
