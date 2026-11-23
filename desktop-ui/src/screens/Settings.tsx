import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, useAction, useApp, useResource } from '../api/hooks';
import { ApiError, type KeyName, type Pipeline, type Provider, type Schedule, type Settings, type SettingsPatch } from '../api/types';
import { Button } from '../components/Button';
import { Checkbox, RadioGroup, Select, Switch, TextField } from '../components/Fields';
import { Page } from '../components/Page';
import { ConfirmInline, LoadError, SkeletonRows } from '../components/States';
import { count, money, when } from '../lib/format';
import { forecast } from '../lib/forecast';
import './Settings.css';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  }
}

const SCHEDULES: { value: string; label: string; schedule: Schedule }[] = [
  { value: 'manual', label: 'Only when I press Scan now', schedule: { mode: 'manual' } },
  { value: 'interval:6', label: 'Every 6 hours', schedule: { mode: 'interval', hours: 6 } },
  { value: 'interval:12', label: 'Every 12 hours', schedule: { mode: 'interval', hours: 12 } },
  { value: 'daily', label: 'Once a day', schedule: { mode: 'daily', at: '06:00' } },
];

const scheduleValue = (s: Schedule): string => (s.mode === 'manual' ? 'manual' : s.mode === 'daily' ? 'daily' : `interval:${s.hours}`);

const PIPELINES: { id: Pipeline; label: string; help: string }[] = [
  { id: 'judge', label: 'Listing check', help: 'Reads eBay and Amazon listings to say whether one is the part.' },
  { id: 'assist', label: 'Ask AI', help: 'Drafts an answer to one Review question from the pages.' },
  { id: 'research', label: 'Research', help: 'Reads Home Depot and brand sites to find a kit’s parts.' },
];

const BRANDS = ['DEWALT', 'RYOBI'];

/** Settings in the spec's two-part rows, saving on change. */
export function SettingsScreen({ focus }: { focus: string | null }) {
  const [res, reload] = useResource(() => api.settings(), []);
  const [saved, setSaved] = useState<string>('Changes save as you make them.');

  useEffect(() => {
    if (!focus || !res.data) return;
    document.getElementById(`settings-${focus}`)?.scrollIntoView({ block: 'start' });
  }, [focus, res.data]);

  return (
    <Page title="Settings" sub={saved}>
      <div className="settings">
        {res.status === 'loading' ? <SkeletonRows rows={8} label="Loading settings" /> : null}
        {res.status === 'error' && !res.data ? <LoadError error={res.error} onRetry={reload} /> : null}
        {res.data ? <SettingsForm initial={res.data} onSaved={(text) => setSaved(text)} /> : null}
      </div>
    </Page>
  );
}

function Row({ id, title, help, children }: { id: string; title: string; help: ReactNode; children: ReactNode }) {
  return (
    <section className="srow" id={`settings-${id}`} aria-labelledby={`settings-${id}-h`}>
      <div className="srow-text">
        <h2 id={`settings-${id}-h`}>{title}</h2>
        <p>{help}</p>
      </div>
      <div className="srow-controls">{children}</div>
    </section>
  );
}

function SettingsForm({ initial, onSaved }: { initial: Settings; onSaved: (text: string) => void }) {
  const { state } = useApp();
  const [s, setS] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = (patch: SettingsPatch, local: Settings, delay = 0) => {
    setS(local);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onSaved('Saving…');
      api
        .patchSettings(patch)
        .then(() => onSaved(`Saved ${when(Date.now())}.`))
        .catch((e: unknown) => onSaved(e instanceof ApiError ? e.message : 'Could not save. Try again.'));
    }, delay);
  };
  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== '' ? n : fallback;
  };

  const budget = state?.budget;
  const f = forecast(s.schedule, s.searchesPerScan, budget?.serpMonthly ?? 250, s.reserve);

  return (
    <>
      <Row id="scanning" title="Scanning" help="How often the agent looks for bundles, and how many searches a scan may use. The reserve is kept for lookups you start.">
        <RadioGroup
          legend="Scan for bundles"
          value={scheduleValue(s.schedule)}
          options={SCHEDULES.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => {
            const schedule = SCHEDULES.find((o) => o.value === v)!.schedule;
            save({ schedule }, { ...s, schedule });
          }}
        />
        {s.schedule.mode === 'daily' ? (
          <TextField
            label="Time"
            type="time"
            mono
            width="sm"
            value={s.schedule.at}
            onChange={(e) => {
              const schedule: Schedule = { mode: 'daily', at: e.target.value };
              save({ schedule }, { ...s, schedule }, 600);
            }}
          />
        ) : null}
        <div className="srow-pair">
          <TextField label="Searches per scan, at most" type="number" min={1} mono width="sm" value={s.searchesPerScan} onChange={(e) => {
            const v = Math.max(1, num(e.target.value, s.searchesPerScan));
            save({ searchesPerScan: v }, { ...s, searchesPerScan: v }, 600);
          }} />
          <TextField label="Always keep in reserve" type="number" min={0} mono width="sm" value={s.reserve} onChange={(e) => {
            const v = Math.max(0, num(e.target.value, s.reserve));
            save({ reserve: v }, { ...s, reserve: v }, 600);
          }} />
        </div>
        <div className={`forecast${f.fits ? '' : ' forecast-over'}`} role="status">
          <div className="forecast-head">
            <strong>{f.sentence}</strong>
            {f.fits ? (
              <span className="fig">
                {count(f.needed)} of {count(f.usable)} usable a month
              </span>
            ) : null}
          </div>
          <p>{f.detail}</p>
        </div>
      </Row>

      <Row id="fees" title="Fees" help="Profit is an estimate from these settings, not your real Amazon fees. Change them to match your account.">
        <div className="srow-grid">
          <TextField label="Referral fee" type="number" step="0.5" mono width="sm" suffix="%" value={round(s.fees.referralRate * 100)} onChange={(e) => feesSave('referralRate', num(e.target.value, s.fees.referralRate * 100) / 100)} />
          <TextField label="Minimum referral" type="number" step="0.01" mono width="sm" prefix="$" value={s.fees.minReferral} onChange={(e) => feesSave('minReferral', num(e.target.value, s.fees.minReferral))} />
          <TextField label="Fulfillment, per part" type="number" step="0.01" mono width="sm" prefix="$" value={s.fees.fulfillmentFee} onChange={(e) => feesSave('fulfillmentFee', num(e.target.value, s.fees.fulfillmentFee))} />
          <TextField label="Sales tax you pay" type="number" step="0.25" mono width="sm" suffix="%" value={round(s.fees.salesTaxRate * 100)} onChange={(e) => feesSave('salesTaxRate', num(e.target.value, s.fees.salesTaxRate * 100) / 100)} />
          <TextField label="Inbound cost, per bundle" type="number" step="0.01" mono width="sm" prefix="$" value={s.fees.inboundCost} onChange={(e) => feesSave('inboundCost', num(e.target.value, s.fees.inboundCost))} />
        </div>
      </Row>

      <Row id="brands" title="What to scan" help="Brands your seller account can list. Each brand costs one search per listing page.">
        <fieldset className="srow-fieldset">
          <legend className="field-label">Brands</legend>
          {BRANDS.map((b) => (
            <Checkbox
              key={b}
              label={b}
              checked={s.brands.includes(b)}
              onChange={(on) => {
                const brands = on ? [...s.brands, b] : s.brands.filter((x) => x !== b);
                if (brands.length === 0) return;
                save({ brands }, { ...s, brands });
              }}
            />
          ))}
        </fieldset>
      </Row>

      <Row id="keys" title="Keys" help="Keys stay in the agent on this Mac. The app can replace or remove one but never reads it back.">
        <KeyField name="serpapi" label="SerpApi key" help={<a href="https://serpapi.com/users/sign_up" target="_blank" rel="noopener noreferrer">Get a free key at serpapi.com</a>} />
        <KeyField name="keepa" label="Keepa key" />
        <KeyField name="anthropic" label="Anthropic key" help="Not checked when saved: a check costs money." />
        <KeyField name="openai" label="OpenAI-compatible key" help="DeepSeek or another OpenAI-compatible service, at the base URL under AI." />
        <KeyField name="ebay" label="eBay App ID and Cert ID" help="Paste them as AppID:CertID. eBay figures are a reference and are not counted." />
      </Row>

      <Row id="ai" title="AI" help="Which model runs each pipeline, and whether answers the code verified apply without you. Unverified answers always wait in Review.">
        <Switch
          label="Autopilot"
          help="Applies AI answers that pass the code’s check after each scan. Each one is listed in Activity with Undo."
          checked={s.ai.autopilot}
          onChange={(autopilot) => save({ ai: { autopilot } }, { ...s, ai: { ...s.ai, autopilot } })}
        />
        <div className="pipelines">
          {PIPELINES.map((p) => {
            const cur = s.ai.pipelines[p.id];
            const setPipe = (next: { provider: Provider; model: string }, delay = 0) => {
              const pipelines = { ...s.ai.pipelines, [p.id]: next };
              save({ ai: { pipelines } }, { ...s, ai: { ...s.ai, pipelines } }, delay);
            };
            return (
              <div className="pipeline" key={p.id}>
                <div className="pipeline-name">
                  <span className="field-label">{p.label}</span>
                  <span className="field-help">{p.help}</span>
                </div>
                <Select label={<span className="sr-only">{p.label} provider</span>} value={cur.provider} width="sm" onChange={(e) => setPipe({ ...cur, provider: e.target.value as Provider })}>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai_compatible">OpenAI-compatible</option>
                </Select>
                <TextField label={<span className="sr-only">{p.label} model</span>} mono width="md" value={cur.model} onChange={(e) => setPipe({ ...cur, model: e.target.value }, 600)} />
              </div>
            );
          })}
        </div>
        <TextField label="OpenAI-compatible base URL" mono value={s.ai.openaiBaseUrl} onChange={(e) => save({ ai: { openaiBaseUrl: e.target.value } }, { ...s, ai: { ...s.ai, openaiBaseUrl: e.target.value } }, 600)} />
        <TextField
          label="Monthly AI cap"
          type="number"
          min={0}
          mono
          width="sm"
          prefix="$"
          value={s.ai.monthlyCapUsd}
          help={budget ? `Spent ${money(budget.aiSpentUsd)} this month. At the cap, AI waits until next month and questions stay in Review.` : undefined}
          onChange={(e) => {
            const v = Math.max(0, num(e.target.value, s.ai.monthlyCapUsd));
            save({ ai: { monthlyCapUsd: v } }, { ...s, ai: { ...s.ai, monthlyCapUsd: v } }, 600);
          }}
        />
      </Row>

      <Row id="alerts" title="Alerts" help="When the agent messages you. A notification comes from this Mac; Telegram carries the same digest, never a key.">
        <div className="srow-pair">
          <TextField label="ROI at least" type="number" mono width="sm" suffix="%" value={round(s.alerts.roiThreshold * 100)} onChange={(e) => alertsSave({ roiThreshold: num(e.target.value, s.alerts.roiThreshold * 100) / 100 })} />
          <TextField label="Estimated profit at least" type="number" mono width="sm" prefix="$" value={s.alerts.profitThreshold} onChange={(e) => alertsSave({ profitThreshold: num(e.target.value, s.alerts.profitThreshold) })} />
        </div>
        <RadioGroup
          legend="Send a digest"
          value={s.alerts.digest}
          options={[
            { value: 'each_scan', label: 'After each scan that finds something' },
            { value: 'daily', label: 'Once a day' },
            { value: 'off', label: 'Never' },
          ]}
          onChange={(digest) => alertsSave({ digest }, 0)}
        />
        <KeyField name="telegram" label="Telegram bot token" />
        <TextField label="Telegram chat id" mono width="md" value={s.alerts.telegramChatId} onChange={(e) => alertsSave({ telegramChatId: e.target.value })} />
      </Row>

      <ChromeRow />
      <GeneralRow />
    </>
  );

  function feesSave(key: keyof Settings['fees'], value: number) {
    const fees = { ...s.fees, [key]: value };
    save({ fees: { [key]: value } }, { ...s, fees }, 600);
  }
  function alertsSave(patch: Partial<Settings['alerts']>, delay = 600) {
    save({ alerts: patch }, { ...s, alerts: { ...s.alerts, ...patch } }, delay);
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A write-only key: the field is always empty; "Saved" says a key is on file. */
export function KeyField({ name, label, help }: { name: KeyName; label: string; help?: ReactNode }) {
  const { state, refreshState } = useApp();
  const has = state?.keys[name] ?? false;
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const put = useAction(api.putKey);
  const del = useAction(api.deleteKey);
  const submit = () => {
    if (!value.trim()) return;
    void put.run(name, value.trim()).then((ok) => {
      if (ok) {
        setValue('');
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
      <TextField
        label={label}
        type="password"
        autoComplete="off"
        spellCheck={false}
        mono
        value={value}
        placeholder={has ? 'Paste a new key to replace it' : 'Paste the key'}
        onChange={(e) => {
          setValue(e.target.value);
          setStatus(null);
          put.clear();
        }}
        help={help}
        status={shown}
      />
      <div className="keyfield-actions">
        <Button type="submit" size="sm" busy={put.busy} busyLabel="Saving…" disabled={!value.trim()}>
          {has ? 'Replace key' : 'Save key'}
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

function ChromeRow() {
  const { state, refreshState } = useApp();
  const [confirm, setConfirm] = useState(false);
  const allow = useAction(api.approvePairing);
  const revoke = useAction(api.revokePairing);
  const h = state?.helper;
  return (
    <Row id="chrome" title="Chrome helper" help="Chrome reads Home Depot pages for the agent while it is open. Pairing lets only your Chrome reach the agent.">
      {h ? (
        <>
          <p className="chrome-state">
            <strong>{h.connected ? 'Connected' : h.paired ? 'Paired, Chrome closed' : 'Not connected'}</strong>
            {h.lastSeenAt ? <span className="muted"> · last seen {when(h.lastSeenAt)}</span> : null}
            {h.jobsWaiting ? <span className="muted"> · {count(h.jobsWaiting)} pages waiting</span> : null}
          </p>
          {!h.paired ? (
            <>
              <ol className="steps">
                <li>In Chrome, open the Split Finder side panel.</li>
                <li>Press Connect to the app there.</li>
                <li>Then allow it here.</li>
              </ol>
              <div className="keyfield-actions">
                <Button variant="primary" busy={allow.busy} busyLabel="Waiting for Chrome…" onClick={() => void allow.run().then(refreshState)}>
                  Allow Chrome to connect
                </Button>
              </div>
              {allow.error ? <p role="alert">{allow.error}</p> : null}
            </>
          ) : confirm ? (
            <ConfirmInline
              question="Revoke Chrome? Home Depot pages wait until you pair it again."
              confirmLabel="Revoke"
              busy={revoke.busy}
              onCancel={() => setConfirm(false)}
              onConfirm={() =>
                void revoke.run().then(() => {
                  setConfirm(false);
                  refreshState();
                })
              }
            />
          ) : (
            <div className="keyfield-actions">
              <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>
                Revoke
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="muted">The agent is not running.</p>
      )}
    </Row>
  );
}

/** Launch at login belongs to the shell; the row shows only inside the app window. */
function GeneralRow() {
  const tauri = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : undefined;
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!tauri) return;
    tauri
      .invoke('get_launch_at_login')
      .then((v) => setOn(Boolean(v)))
      .catch(() => setError('Could not read the login setting.'));
  }, [tauri]);
  if (!tauri) return null;
  return (
    <Row id="general" title="General" help="The agent keeps running in the menu bar when the window is closed.">
      <Switch
        label="Launch at login"
        checked={on ?? false}
        disabled={on === null}
        onChange={(next) => {
          setOn(next);
          tauri.invoke('set_launch_at_login', { enabled: next }).catch(() => {
            setOn(!next);
            setError('Could not change the login setting.');
          });
        }}
      />
      {error ? <p role="alert">{error}</p> : null}
    </Row>
  );
}
