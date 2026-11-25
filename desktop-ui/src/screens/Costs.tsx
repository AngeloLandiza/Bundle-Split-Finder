import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, useApp, useResource } from '../api/hooks';
import { ApiError, type BudgetedService, type CostSettings, type CostState, type CostsView, type ServiceCost } from '../api/types';
import { Button, LinkButton } from '../components/Button';
import { CostChart } from '../components/CostChart';
import { Checkbox, Slider, Switch, TextField } from '../components/Fields';
import { Fold } from '../components/Fold';
import { Glyph } from '../components/Glyph';
import { Section } from '../components/Layout';
import { Page } from '../components/Page';
import { LoadError, LoadingState } from '../components/States';
import {
  amount, costWords, dayLabel, dayOf, daysInMonth, describeChange, fieldText, forecastNote, forecastWords, isBudgeted, limitNote, limitRange, limitToStartAt, meterOf, mergeCostPatch, numbersTable,
  patchOf, readField, sliderAt, stateLabel, stateMark, stripBars, syncLimit, unitNoun, unpricedSentence, withField, fieldKey,
  type CostField, type CostSettingsPatch, type CostValue, type SliderRange,
} from '../lib/costs';
import { count, money, when } from '../lib/format';
import { NumberField } from './preferences/form';
import './Costs.css';

const SAVE_DELAY = 600;

/** The months as the owner reads them: "November 2026". */
const monthWords = (month: string): string => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

const TOTAL_STATE: Record<CostState, string | null> = { ok: null, approaching: 'Nearing your budget', expected_over: 'Expected to pass your budget', over: 'Over your budget', blocked: 'Something was held back' };

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; text: string };
interface Change {
  text: string;
  /** What to write back to take it back: each field's value before. Empty once it has been undone. */
  undo: { field: CostField; before: CostValue }[];
}

/**
 * Settings that save as they are changed, as everywhere in the app: the screen shows the change at once (`draft`), sends what
 * changed after a short pause so a drag or typing is one save, and then shows the agent's own answer, since a limit moves the
 * states and the forecast. The last change is said in a sentence with an Undo that writes the old value back.
 */
function useCostSettings(view: CostsView | null, setView: (v: CostsView) => void, reload: () => void) {
  const [draft, setDraft] = useState<CostSettings | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [change, setChange] = useState<Change | null>(null);
  const draftRef = useRef<CostSettings | null>(null);
  const viewRef = useRef<CostsView | null>(view);
  viewRef.current = view;
  const pending = useRef<CostSettingsPatch>({});
  const burst = useRef(new Map<string, { field: CostField; before: CostValue }>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoing = useRef(false);

  const flush = useCallback(async () => {
    timer.current = null;
    const patch = pending.current;
    if (Object.keys(patch).length === 0) return;
    const fields = [...burst.current.values()];
    pending.current = {};
    burst.current = new Map();
    const wasUndo = undoing.current;
    undoing.current = false;
    setStatus({ kind: 'saving' });
    try {
      const next = await api.patchCosts(patch);
      if (Object.keys(pending.current).length === 0) {
        draftRef.current = null;
        setDraft(null);
      }
      setView(next);
      setStatus({ kind: 'saved' });
      const changed = fields.filter((f) => f.before !== readField(next.settings, f.field));
      setChange(
        changed.length === 0
          ? null
          : { text: `${wasUndo ? 'Undone. ' : ''}${changed.map((f) => describeChange(f.field, f.before, readField(next.settings, f.field), next)).join(' ')}`, undo: wasUndo ? [] : changed },
      );
    } catch (e) {
      // What the agent refused is not saved: say so, and show what it holds.
      pending.current = {};
      burst.current = new Map();
      draftRef.current = null;
      setDraft(null);
      setStatus({ kind: 'error', text: e instanceof ApiError ? e.message : 'Could not save. Try again.' });
      reload();
    }
  }, [setView, reload]);

  const edit = useCallback(
    (field: CostField, value: CostValue, delay = SAVE_DELAY) => {
      const cur = draftRef.current ?? viewRef.current?.settings;
      if (!cur) return;
      const before = readField(cur, field);
      if (before === value) return;
      const key = fieldKey(field);
      // The first value of a burst is the one an Undo goes back to.
      if (!burst.current.has(key)) burst.current.set(key, { field, before });
      const next = withField(cur, field, value);
      draftRef.current = next;
      setDraft(next);
      pending.current = mergeCostPatch(pending.current, patchOf(field, value));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    },
    [flush],
  );

  const undo = useCallback(() => {
    if (!change || change.undo.length === 0) return;
    undoing.current = true;
    for (const u of change.undo) edit(u.field, u.before, 0);
  }, [change, edit]);

  // Leaving the screen mid-drag still saves what was changed.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
    },
    [flush],
  );

  return { settings: draft ?? view?.settings ?? null, edit, undo, status, change };
}

/** The money the services cost, this month and by its end, against what he allows (docs/design.md, Desktop app > Costs). */
export function CostsScreen() {
  const { online } = useApp();
  const [res, reload] = useResource(() => api.costs(), [], ['activity']);
  const [view, setViewState] = useState<CostsView | null>(null);
  const saving = useRef(false);
  const setView = useCallback((v: CostsView) => setViewState(v), []);
  useEffect(() => {
    if (res.data && !saving.current) setViewState(res.data);
  }, [res.data]);
  // The agent's answers come back when this window is in front again, since use goes on while it is not.
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  const { settings, edit, undo, status, change } = useCostSettings(view, setView, reload);
  saving.current = status.kind === 'saving';

  return (
    <Page title="Costs" sub={view ? monthWords(view.month) : undefined} grouped costNotice={false}>
      <div className="costs">
        {res.status === 'loading' && !view ? <LoadingState label="Loading what it costs" /> : null}
        {res.status === 'error' && !view ? <LoadError error={res.error} onRetry={reload} /> : null}
        {res.status === 'error' && view ? (
          <p className="costs-stale" role="status">
            {online ? 'The agent did not answer just now.' : 'The agent is not running.'} These figures are from {when(view.at)}.{' '}
            <LinkButton onClick={reload}>Try again</LinkButton>
          </p>
        ) : null}
        {view && settings ? (
          <>
            <Answer view={view} edit={edit} settings={settings} />
            <Section label="Dollars this month" flush note={<ChartNote view={view} />}>
              <CostChart view={view} />
              <div className="costs-numbers">
                <Fold id="costs-numbers" title="Show the numbers" aside="the chart as a table">
                  <NumbersTable view={view} />
                </Fold>
              </div>
            </Section>
            <ChangeLine status={status} change={change} onUndo={undo} />
            <Section label="Services" count={view.services.filter((s) => isBudgeted(s.service)).length} flush note="Use is counted by the app’s own ledgers. A forecast is an estimate from your own use, not a bill.">
              <ul className="rows">
                {view.services
                  .filter((s) => isBudgeted(s.service))
                  .map((s) => (
                    <ServiceRow key={s.service} view={view} s={s} settings={settings} edit={edit} />
                  ))}
              </ul>
            </Section>
            <Section label="Month total" flush>
              <TotalControls view={view} settings={settings} edit={edit} />
            </Section>
            {view.services.some((s) => !isBudgeted(s.service)) ? (
              <Section label="Free services" flush note="They cost nothing; they are listed because each has a limit of its own.">
                <ul className="rows">
                  {view.services
                    .filter((s) => !isBudgeted(s.service))
                    .map((s) => (
                      <li key={s.service} className="crow crow-quiet">
                        <h3 className="crow-name">{s.label}</h3>
                        <p className="crow-sentence">{s.sentence}</p>
                        <span className="crow-cost">{costWords(s).text}</span>
                      </li>
                    ))}
                </ul>
              </Section>
            ) : null}
          </>
        ) : null}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------- the answer first

type Edit = (field: CostField, value: CostValue, delay?: number) => void;

/** One sentence: so far, the forecast, the budget. A price that is missing is said right here, with the field to enter it. */
function Answer({ view, settings, edit }: { view: CostsView; settings: CostSettings; edit: Edit }) {
  const t = view.total;
  const note = TOTAL_STATE[t.state];
  const missing = unpricedSentence(view);
  return (
    <section className="costs-answer" aria-label="The answer">
      {note ? (
        <p className="costs-state">
          <Glyph name="warning" size={14} className="costs-state-glyph" />
          {note}
        </p>
      ) : null}
      <p className="costs-sentence">{t.sentence}</p>
      {missing ? (
        <div className="costs-missing">
          <p>{missing}</p>
          <div className="costs-missing-fields">
            {t.unpriced.filter(isBudgeted).map((service) => (
              <PriceField key={service} view={view} service={service} settings={settings} edit={edit} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** What he pays a service each month; empty means not entered, which is never counted as $0. */
function PriceField({ view, service, settings, edit }: { view: CostsView; service: BudgetedService; settings: CostSettings; edit: Edit }) {
  const price = settings.services[service].monthlyPriceUsd;
  const label = view.services.find((s) => s.service === service)?.label ?? service;
  return (
    <div className="costs-price">
      <span className="costs-price-label">{label} monthly price</span>
      <NumberField
        label={`${label} monthly price in dollars`}
        value={price ?? Number.NaN}
        rule={{ min: 0, what: `${label} price`, unit: '$' }}
        prefix="$"
        step="0.01"
        placeholder="not entered"
        onCommit={(v) => edit({ kind: 'price', service }, v)}
        onClear={() => edit({ kind: 'price', service }, null)}
      />
      <span className="costs-price-unit">a month</span>
    </div>
  );
}

// ---------------------------------------------------------------- the chart's note and its numbers

function ChartNote({ view }: { view: CostsView }) {
  return (
    <>
      {forecastNote(view)}
      {view.days.length === 1 ? ' It is the first day of the month, so the line starts today.' : ''}
    </>
  );
}

function NumbersTable({ view }: { view: CostsView }) {
  const t = numbersTable(view);
  return (
    <div className="costs-table-wrap">
      <table className="costs-table">
        <caption className="sr-only">Dollars by day this month, by service</caption>
        <thead>
          <tr>
            {t.head.map((h, i) => (
              <th key={h} scope="col" className={i === 0 ? '' : 'costs-num'}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r) => (
            <tr key={r[0]}>
              {r.map((c, i) => (i === 0 ? <th key={i} scope="row">{c}</th> : <td key={i} className="costs-num fig">{c}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="costs-lines">
        {t.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- what changed, with Undo

function ChangeLine({ status, change, onUndo }: { status: Status; change: Change | null; onUndo: () => void }) {
  const saving = status.kind === 'saving';
  if (status.kind === 'error') {
    return (
      <p className="costs-change costs-change-error" role="alert">
        <Glyph name="warning" size={13} /> {status.text} Nothing was changed.
      </p>
    );
  }
  if (!change && !saving) return null;
  return (
    <p className="costs-change" role="status">
      <span>{saving ? 'Saving…' : change?.text}</span>
      {!saving && change && change.undo.length > 0 ? (
        <Button size="sm" variant="quiet" onClick={onUndo}>
          Undo
        </Button>
      ) : null}
    </p>
  );
}

// ---------------------------------------------------------------- one service

function ServiceRow({ view, s, settings, edit }: { view: CostsView; s: ServiceCost; settings: CostSettings; edit: Edit }) {
  const service = s.service as BudgetedService;
  const cfg = settings.services[service];
  const cost = costWords(s);
  const mark = stateMark(s.state);
  const meter = meterOf({ ...s, limit: cfg.monthlyLimit }, cfg.warnAtPercent);
  const strip = useMemo(() => stripBars(s.days, daysInMonth(view.month), 150, 22), [s.days, view.month]);
  const range = limitRange(service, view);
  const note = limitNote(s, cfg.monthlyLimit, settings.blockWhenOver);
  const id = useId();
  return (
    <li className="crow" aria-labelledby={`${id}-name`}>
      <div className="crow-head">
        <h3 className="crow-name" id={`${id}-name`}>
          {s.label}
        </h3>
        <span className={`crow-state crow-state-${s.state}`}>
          <Glyph name={mark} size={13} />
          {stateLabel(s)}
        </span>
        <span className={`crow-cost${cost.missing ? ' crow-cost-missing' : ''}`}>{cost.text}</span>
      </div>
      <p className="crow-sentence">{s.sentence}</p>
      {meter ? <CostMeter {...meter} state={s.state} label={`${s.label} used this month against its ${cfg.monthlyLimit !== null ? 'limit' : 'plan limit'}`} warnPercent={cfg.warnAtPercent} unit={s.unit} /> : null}
      <div className="crow-use">
        {strip.bars.length > 0 ? (
          <svg className="crow-strip" width={150} height={22} viewBox="0 0 150 22" role="img" aria-label={`Daily use, ${s.label}: busiest day ${dayLabel(view.month, dayOf(strip.peak!.date))}, ${amount(strip.peak!.used, s.unit)}.`} focusable="false">
            <line x1={0} x2={150} y1={21.5} y2={21.5} className="crow-strip-base" />
            {strip.bars.map((b) => (
              <rect key={b.date} x={b.x} y={22 - b.height} width={b.width} height={b.height} className="crow-strip-bar">
                <title>{`${dayLabel(view.month, dayOf(b.date))}: ${amount(b.used, s.unit)}`}</title>
              </rect>
            ))}
          </svg>
        ) : (
          <span className="crow-strip-none">No use yet this month</span>
        )}
        <p className="crow-forecast">
          <span className="crow-forecast-label">Forecast for the month</span> {forecastWords(s)}
        </p>
      </div>
      {s.blocked.length > 0 ? (
        <ul className="crow-blocked" aria-label="Held back">
          {s.blocked.map((b, i) => (
            <li key={i}>
              <strong>Held back: {b.what}.</strong> {b.why} <span className="crow-when">{when(b.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="crow-ctl">
        <span className="crow-ctl-label">Limit</span>
        <LimitControl
          name={`${s.label} monthly limit`}
          value={cfg.monthlyLimit}
          range={range}
          unit={s.unit}
          noun={unitNoun(s.unit)}
          startAt={limitToStartAt(service, view)}
          onChange={(v) => edit({ kind: 'limit', service }, v)}
        />
        {note ? <p className="crow-ctl-note">{note}</p> : null}
        <span className="crow-ctl-label">Warn me at</span>
        <div className="crow-ctl-one">
          <NumberField label={`${s.label} warning, percent of the limit`} value={cfg.warnAtPercent} rule={{ min: 1, max: 100, whole: true, what: 'Warn at', unit: '%' }} suffix="%" width="xs" onCommit={(v) => edit({ kind: 'warn', service }, v)} />
          <span className="crow-ctl-unit">of the limit</span>
        </div>
        {service !== 'ai' ? (
          <>
            <span className="crow-ctl-label">Monthly price</span>
            <div className="crow-ctl-one">
              <NumberField
                label={`${s.label} monthly price in dollars`}
                value={cfg.monthlyPriceUsd ?? Number.NaN}
                rule={{ min: 0, what: `${s.label} price`, unit: '$' }}
                prefix="$"
                step="0.01"
                placeholder="not entered"
                width="sm"
                onCommit={(v) => edit({ kind: 'price', service }, v)}
                onClear={() => edit({ kind: 'price', service }, null)}
              />
              <span className="crow-ctl-unit">a month</span>
            </div>
          </>
        ) : null}
      </div>
    </li>
  );
}

/** Used against its limit, with the warn mark on the track. The words beside it say the same; the colour is a second signal only. */
function CostMeter({ value, max, warnAt, state, label, warnPercent, unit }: { value: number; max: number; warnAt: number; state: CostState; label: string; warnPercent: number; unit: ServiceCost['unit'] }) {
  const share = Math.max(0, Math.min(1, value / max));
  return (
    <div className="cmeter-row">
      <span
        className={`cmeter${state !== 'ok' ? ' cmeter-hot' : ''}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
        aria-valuetext={`${amount(value, unit)} of ${amount(max, unit)}; warning at ${warnPercent}%`}
      >
        <span className="cmeter-fill" style={{ inlineSize: `${share * 100}%` }} />
        <span className="cmeter-tick" style={{ insetInlineStart: `${warnAt * 100}%` }} aria-hidden="true" />
      </span>
      <span className="cmeter-words fig">
        {unit === 'usd' ? money(value) : count(Math.round(value))} of {unit === 'usd' ? money(max) : count(Math.round(max))}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- limits: a slider and a number that are one value

/**
 * A limit: a slider with a number field beside it, both editing the same value, and "No limit" as its own checkbox (never the
 * slider's far end). Typing a figure the slider cannot reach pegs the slider at its end and keeps the figure.
 */
function LimitControl({ name, value, range, unit, noun, startAt, onChange, prefix }: { name: string; value: number | null; range: SliderRange; unit: ServiceCost['unit']; noun: string; startAt: number; onChange: (v: number | null) => void; prefix?: string }) {
  const [text, setText] = useState(fieldText(value));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(fieldText(value));
      setError(null);
    }
  }, [value]);
  const none = value === null;
  const dollars = unit === 'usd';
  return (
    <div className="limit">
      <div className="limit-main">
        <Slider
          label={name}
          value={none ? range.max : sliderAt(value, range)}
          min={range.min}
          max={range.max}
          step={range.step}
          disabled={none}
          valueText={none ? 'No limit' : amount(value, unit)}
          onChange={(v) => {
            const r = syncLimit({ by: 'slider', value: v }, range, unit);
            setText(r.text);
            setError(null);
            if (r.value !== null) onChange(r.value);
          }}
        />
        <TextField
          label={<span className="sr-only">{name}, number</span>}
          type="number"
          mono
          width="sm"
          min={0}
          step={dollars ? '0.01' : '1'}
          prefix={prefix ?? (dollars ? '$' : undefined)}
          suffix={none ? undefined : noun || undefined}
          placeholder={none ? 'No limit' : undefined}
          disabled={none}
          value={none ? '' : text}
          status={error ? { tone: 'error', text: error } : null}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
            if (!error && !none) setText(fieldText(value));
          }}
          onChange={(e) => {
            setText(e.target.value);
            const r = syncLimit({ by: 'field', text: e.target.value }, range, unit);
            setError(r.error);
            if (r.value !== null) onChange(r.value);
          }}
        />
      </div>
      <Checkbox
        label="No limit"
        checked={none}
        onChange={(checked) => {
          if (checked) onChange(null);
          else {
            setText(fieldText(startAt));
            setError(null);
            onChange(startAt);
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- the whole month

function TotalControls({ view, settings, edit }: { view: CostsView; settings: CostSettings; edit: Edit }) {
  const range = limitRange('total', view);
  return (
    <div className="crow crow-total">
      <div className="crow-ctl">
        <span className="crow-ctl-label">Total budget</span>
        <LimitControl name="Total monthly budget" value={settings.totalMonthlyUsd} range={range} unit="usd" noun="" startAt={limitToStartAt('total', view)} onChange={(v) => edit({ kind: 'total' }, v)} />
        <p className="crow-ctl-note">The most all services together may cost a month: fixed prices plus what is metered. {settings.totalMonthlyUsd === null ? 'No budget is set, so the chart has no rule.' : `${money(view.total.spentUsd)} of it so far.`}</p>
        <span className="crow-ctl-label">Holding back</span>
        <div className="crow-ctl-one">
          <Switch
            label="Hold back anything expected to pass a limit"
            name="Hold back anything expected to pass a limit"
            help="A step that would take a service past its limit does not run; the rest of the scan does. Activity and a notice say what was held back. Off, you are warned and nothing is stopped."
            checked={settings.blockWhenOver}
            onChange={(v) => edit({ kind: 'block' }, v, 0)}
          />
        </div>
      </div>
    </div>
  );
}

