import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type * as C from '@core/api/contract';
import { api, useAction, useApp, useResource } from '../api/hooks';
import { ApiError, type AppSettings, type KeyName, type Schedule, type SettingsPatch } from '../api/types';
import { Button } from '../components/Button';
import { Checkbox, RadioGroup, Select, Switch, TextField } from '../components/Fields';
import { Page } from '../components/Page';
import { ConfirmInline, LoadError, Notice, SkeletonRows } from '../components/States';
import { count, money, when } from '../lib/format';
import { forecast } from '../lib/forecast';
import { mergePatch } from '../lib/patch';
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

type Pipeline = 'judge' | 'assist' | 'research';
type Provider = AppSettings['ai']['judge']['provider'];

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

function SettingsForm({ initial, onSaved }: { initial: AppSettings; onSaved: (text: string) => void }) {
  const { state } = useApp();
  const [s, setS] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Edits wait a moment so typing is one save. Several fields edited inside that moment are one patch: a field is never
  // dropped because another was touched after it. `then` takes the agent's answer, for what the agent sets by itself
  // (a provider change sets its key and its trust).
  const pending = useRef<{ patch: SettingsPatch; thens: ((saved: AppSettings) => void)[] }>({ patch: {}, thens: [] });
  const save = (patch: SettingsPatch, local: AppSettings, delay = 0, then?: (saved: AppSettings) => void) => {
    setS(local);
    pending.current.patch = mergePatch(pending.current.patch, patch);
    if (then) pending.current.thens.push(then);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const { patch: send, thens } = pending.current;
      pending.current = { patch: {}, thens: [] };
      onSaved('Saving…');
      api
        .patchSettings(send)
        .then((saved) => {
          onSaved(`Saved ${when(Date.now())}.`);
          thens.forEach((fn) => fn(saved));
        })
        .catch((e: unknown) => onSaved(e instanceof ApiError ? e.message : 'Could not save. Try again.'));
    }, delay);
  };
  /** The scanning settings (schedule, searches, fees, brands) in the contract's `settings` block. */
  const setSettings = (part: Partial<AppSettings['settings']>, delay = 0) => save({ settings: part }, { ...s, settings: { ...s.settings, ...part } }, delay);
  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== '' ? n : fallback;
  };

  const budget = state?.budget;
  const f = forecast(s.settings.schedule, s.settings.searchesPerScan, budget?.serpMonthly ?? 250, s.settings.reserve);

  return (
    <>
      <Row id="scanning" title="Scanning" help="How often the agent looks for bundles, and how many searches a scan may use. The reserve is kept for lookups you start.">
        <RadioGroup
          legend="Scan for bundles"
          value={scheduleValue(s.settings.schedule)}
          options={SCHEDULES.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => {
            const schedule = SCHEDULES.find((o) => o.value === v)!.schedule;
            setSettings({ schedule });
          }}
        />
        {s.settings.schedule.mode === 'daily' ? (
          <TextField
            label="Time"
            type="time"
            mono
            width="sm"
            value={s.settings.schedule.at}
            onChange={(e) => {
              const schedule: Schedule = { mode: 'daily', at: e.target.value };
              setSettings({ schedule }, 600);
            }}
          />
        ) : null}
        <div className="srow-pair">
          <TextField label="Searches per scan, at most" type="number" min={1} mono width="sm" value={s.settings.searchesPerScan} onChange={(e) => {
            const v = Math.max(1, num(e.target.value, s.settings.searchesPerScan));
            setSettings({ searchesPerScan: v }, 600);
          }} />
          <TextField label="Always keep in reserve" type="number" min={0} mono width="sm" value={s.settings.reserve} onChange={(e) => {
            const v = Math.max(0, num(e.target.value, s.settings.reserve));
            setSettings({ reserve: v }, 600);
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
          <TextField label="Referral fee" type="number" step="0.5" mono width="sm" suffix="%" value={round(s.settings.fees.referralRate * 100)} onChange={(e) => feesSave('referralRate', num(e.target.value, s.settings.fees.referralRate * 100) / 100)} />
          <TextField label="Minimum referral" type="number" step="0.01" mono width="sm" prefix="$" value={s.settings.fees.minReferral} onChange={(e) => feesSave('minReferral', num(e.target.value, s.settings.fees.minReferral))} />
          <TextField label="Fulfillment, per part" type="number" step="0.01" mono width="sm" prefix="$" value={s.settings.fees.fulfillmentFee} onChange={(e) => feesSave('fulfillmentFee', num(e.target.value, s.settings.fees.fulfillmentFee))} />
          <TextField label="Sales tax you pay" type="number" step="0.25" mono width="sm" suffix="%" value={round(s.settings.fees.salesTaxRate * 100)} onChange={(e) => feesSave('salesTaxRate', num(e.target.value, s.settings.fees.salesTaxRate * 100) / 100)} />
          <TextField label="Inbound cost, per bundle" type="number" step="0.01" mono width="sm" prefix="$" value={s.settings.fees.inboundCost} onChange={(e) => feesSave('inboundCost', num(e.target.value, s.settings.fees.inboundCost))} />
        </div>
      </Row>

      <Row id="brands" title="What to scan" help="Brands your seller account can list. Each brand costs one search per listing page.">
        <fieldset className="srow-fieldset">
          <legend className="field-label">Brands</legend>
          {BRANDS.map((b) => (
            <Checkbox
              key={b}
              label={b}
              checked={s.settings.brands.includes(b)}
              onChange={(on) => {
                const brands = on ? [...s.settings.brands, b] : s.settings.brands.filter((x) => x !== b);
                if (brands.length === 0) return;
                setSettings({ brands });
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
        <KeyField
          name="ebay"
          label="eBay keys"
          fields={[
            { id: 'appId', label: 'eBay App ID' },
            { id: 'certId', label: 'eBay Cert ID' },
          ]}
          help="eBay figures are a reference and are not counted."
        />
      </Row>

      <Row id="ai" title="AI" help="Which model runs each pipeline, and whether answers the code verified apply without you. Unverified answers always wait in Review.">
        <Switch
          label="Autopilot"
          help="Applies AI answers that pass the code’s check after each scan, from a model marked trusted below. Each one is listed in Activity with Undo."
          checked={s.autopilot}
          onChange={(autopilot) => save({ autopilot }, { ...s, autopilot })}
        />
        <div className="pipelines">
          {PIPELINES.map((p) => {
            const cur = s.ai[p.id];
            const setPipe = (next: Partial<AppSettings['ai']['judge']>, delay = 0, then?: (saved: AppSettings) => void) =>
              save({ ai: { [p.id]: next } }, { ...s, ai: { ...s.ai, [p.id]: { ...cur, ...next } } }, delay, then);
            return (
              <div className="pipeline" key={p.id}>
                <div className="pipeline-name">
                  <span className="field-label">{p.label}</span>
                  <span className="field-help">{p.help}</span>
                </div>
                <Select
                  label={<span className="sr-only">{p.label} provider</span>}
                  value={cur.provider}
                  width="sm"
                  onChange={(e) =>
                    // The agent picks the key and the trust for the new provider; take its answer.
                    setPipe({ provider: e.target.value as Provider }, 0, (saved) => setS((now) => ({ ...now, ai: { ...now.ai, [p.id]: saved.ai[p.id] } })))
                  }
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                </Select>
                <TextField label={<span className="sr-only">{p.label} model</span>} mono width="md" value={cur.model} onChange={(e) => setPipe({ model: e.target.value }, 600)} />
                {cur.provider === 'openai-compatible' ? (
                  <TextField label={<span className="sr-only">{p.label} base URL</span>} placeholder="Base URL, https://api.deepseek.com" mono value={cur.baseUrl ?? ''} onChange={(e) => setPipe({ baseUrl: e.target.value }, 600)} />
                ) : null}
                <Checkbox label="Autopilot may apply this model’s verified answers" checked={cur.trusted} onChange={(trusted) => setPipe({ trusted })} />
              </div>
            );
          })}
        </div>
        <TextField
          label="Monthly AI cap"
          type="number"
          min={0}
          mono
          width="sm"
          prefix="$"
          value={s.ai.monthlyCapUsd}
          help={budget ? `Spent ${money(budget.aiSpentUsd)} this month. At the cap, AI waits until next month and questions stay in Review. 0 turns the AI off.` : undefined}
          onChange={(e) => {
            const v = Math.max(0, num(e.target.value, s.ai.monthlyCapUsd));
            save({ ai: { monthlyCapUsd: v } }, { ...s, ai: { ...s.ai, monthlyCapUsd: v } }, 600);
          }}
        />
      </Row>

      <Row id="alerts" title="Alerts" help="When the agent messages you. A notification comes from this Mac; Telegram carries the same digest, never a key. Profit and ROI in a message are estimates.">
        <Switch label="Message me about deals" checked={s.alerts.enabled} onChange={(enabled) => alertsSave({ enabled }, 0)} />
        <div className="srow-pair">
          <TextField label="ROI at least" type="number" mono width="sm" suffix="%" value={s.alerts.minRoiPercent} onChange={(e) => alertsSave({ minRoiPercent: Math.max(0, num(e.target.value, s.alerts.minRoiPercent)) })} />
          <TextField label="Estimated profit at least" type="number" mono width="sm" prefix="$" value={s.alerts.minProfit} onChange={(e) => alertsSave({ minProfit: Math.max(0, num(e.target.value, s.alerts.minProfit)) })} />
        </div>
        <Checkbox label="Also tell me when questions are waiting in Review" checked={s.alerts.reviewDigest} onChange={(reviewDigest) => alertsSave({ reviewDigest }, 0)} />
        <KeyField
          name="telegram"
          label="Telegram"
          fields={[
            { id: 'botToken', label: 'Telegram bot token' },
            { id: 'chatId', label: 'Telegram chat id' },
          ]}
        />
      </Row>

      <ChromeRow />
      <GeneralRow />
    </>
  );

  function feesSave(key: keyof AppSettings['settings']['fees'], value: number) {
    setSettings({ fees: { ...s.settings.fees, [key]: value } }, 600);
  }
  function alertsSave(patch: Partial<AppSettings['alerts']>, delay = 600) {
    save({ alerts: patch }, { ...s, alerts: { ...s.alerts, ...patch } }, delay);
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

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
 * Used by Settings › Chrome helper and by the first run's Connect Chrome step.
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

function ChromeRow() {
  const { state, refreshState, pairing } = useApp();
  const [res, reload] = useResource(() => api.pairedExtensions(), [], ['state']);
  const [confirm, setConfirm] = useState<string | null>(null);
  const revoke = useAction(api.revokeExtension);
  const h = state?.helper;
  const paired = res.data ?? [];
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
            <ol className="steps">
              <li>In Chrome, open the Split Finder side panel.</li>
              <li>Press Connect to the app there.</li>
              <li>{pairing.requests.length ? 'Allow it in the band at the top of this page.' : 'Chrome then asks here; check the code and allow it.'}</li>
            </ol>
          ) : null}
          <InstallHelper />
          {res.status === 'error' && !res.data ? <LoadError error={res.error} onRetry={reload} /> : null}
          {paired.length ? (
            <ul className="paired">
              {paired.map((x) => (
                <li key={x.extensionId} className="paired-row">
                  <span className="paired-what">
                    <span className="fig paired-id" title={x.extensionId}>
                      {x.extensionId}
                    </span>
                    <span className="muted">
                      paired {when(x.pairedAt)}
                      {x.lastSeenAt ? `, last seen ${when(x.lastSeenAt)}` : ''}
                    </span>
                  </span>
                  {confirm === x.extensionId ? (
                    <ConfirmInline
                      question="Revoke this Chrome? Home Depot pages wait until you pair it again."
                      confirmLabel="Revoke"
                      busy={revoke.busy}
                      onCancel={() => setConfirm(null)}
                      onConfirm={() =>
                        void revoke.run(x.extensionId).then((ok) => {
                          if (ok) setConfirm(null);
                          reload();
                          refreshState();
                        })
                      }
                    />
                  ) : (
                    <Button variant="danger" size="sm" onClick={() => setConfirm(x.extensionId)}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {revoke.error ? <p role="alert">{revoke.error}</p> : null}
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
