// The welcome sheet's fourth step, "Let it run by itself": the schedule the account's searches can pay for, preselected,
// with the arithmetic in plain words, the other choices, and the two switches that make a background agent actually run
// (open at login, keep the computer awake while a scan runs). The recommendation is core's (core/src/schedule/recommend.ts);
// nothing here chooses a number.

import { useMemo } from 'react';
import { recommendSchedule, type ScheduleOptionId, type ScheduleRecommendation } from '@core/schedule/recommend';
import { api, useApp, useResource } from '../api/hooks';
import type { AppSettings } from '../api/types';
import { Switch } from '../components/Fields';
import { Glyph } from '../components/Glyph';
import { Notice } from '../components/States';
import { count, plural } from '../lib/format';
import { words } from '../lib/platform';

export interface RunChoice {
  schedule: ScheduleOptionId | null;
  login: boolean | null;
  awake: boolean | null;
}

export const NO_CHOICE: RunChoice = { schedule: null, login: null, awake: null };

/** What the step shows with the owner's picks laid over the defaults. */
export interface RunPlan {
  rec: ScheduleRecommendation;
  settings: AppSettings;
  schedule: ScheduleOptionId;
  login: boolean;
  awake: boolean;
}

/** The step's data: the settings and the recent runs, then core's recommendation. null while they load or when they cannot be read. */
export function useRunPlan(choice: RunChoice): { plan: RunPlan | null; failed: boolean } {
  const { state } = useApp();
  const [settings] = useResource(() => api.settings(), []);
  const [activity] = useResource(() => api.activity(), []);
  const s = settings.data;
  const runs = activity.data?.runs;
  const serpLeft = state?.budget.serpLeft ?? null;
  const serpMonthly = state?.budget.serpMonthly ?? null;
  const hasKeepa = Boolean(state?.keys.keepa);
  const rec = useMemo(() => {
    if (!s) return null;
    return recommendSchedule({
      monthly: serpMonthly,
      reserve: s.settings.reserve,
      perScanCap: s.settings.searchesPerScan,
      hasKeepa: hasKeepa && s.settings.amazonRefreshViaKeepa,
      searchesLeft: serpLeft,
      recentRuns: (runs ?? []).filter((r) => r.result !== 'running').map((r) => ({ kind: r.kind, status: r.result, searchesUsed: r.searches })),
      now: new Date(),
    });
  }, [s, runs, serpMonthly, serpLeft, hasKeepa]);
  if (!s || !rec) return { plan: null, failed: settings.status === 'error' };
  // A schedule the owner already runs stays preselected when it is one of the choices; otherwise the recommendation.
  const current = rec.options.find((o) => o.schedule.mode !== 'manual' && JSON.stringify(o.schedule) === JSON.stringify(s.settings.schedule));
  return {
    failed: false,
    plan: {
      rec,
      settings: s,
      schedule: choice.schedule ?? current?.id ?? rec.option.id,
      // A background agent that is not running finds nothing: on here unless the owner already chose otherwise.
      login: choice.login ?? true,
      awake: choice.awake ?? s.shell.keepAwakeDuringScan,
    },
  };
}

const basisSentence = (rec: ScheduleRecommendation, hasKeepa: boolean): string => {
  if (rec.perScanBasis === 'recent') return 'The searches a scan uses come from your recent scans.';
  return hasKeepa ? 'A scan with a Keepa key uses about that many.' : 'Without a Keepa key each new Amazon lookup also costs a search; real scans will correct this.';
};

export function RunStep({ plan, failed, choice, onChoose, saved }: { plan: RunPlan | null; failed: boolean; choice: RunChoice; onChoose: (c: RunChoice) => void; saved: string | null }) {
  const { online, state } = useApp();
  if (!plan) {
    return failed || !online ? (
      <Notice tone="attention" title="The plan could not be read.">
        {online ? 'Try again in a moment, or choose a schedule later in Settings.' : 'The agent is not running. Choose a schedule later in Settings.'}
      </Notice>
    ) : (
      <p className="welcome-quiet">Reading your plan…</p>
    );
  }
  const { rec } = plan;
  const hasKeepa = Boolean(state?.keys.keepa) && plan.settings.settings.amazonRefreshViaKeepa;
  const chosen = rec.options.find((o) => o.id === plan.schedule)!;
  const set = (patch: Partial<RunChoice>) => onChoose({ ...choice, ...patch });

  if (saved) {
    return (
      <p className="welcome-done">
        <Glyph name="check" size={14} />
        {saved}
      </p>
    );
  }
  return (
    <>
      <p>Scans can run on their own. This is the most frequent schedule your search plan can pay for without touching your reserve.</p>

      <fieldset className="radios welcome-schedule">
        <legend className="field-label">How often</legend>
        {rec.options.map((o) => {
          const recommended = o.id === rec.option.id;
          const manual = o.id === 'manual';
          const disabled = !o.fits;
          return (
            <label key={o.id} className={`radio welcome-option${disabled ? ' welcome-option-off' : ''}`}>
              <input type="radio" name="welcome-schedule" value={o.id} checked={o.id === plan.schedule} disabled={disabled} onChange={() => set({ schedule: o.id })} />
              <span className="welcome-option-label">{o.label}</span>
              {recommended && !manual ? <span className="welcome-option-note welcome-option-rec">Recommended</span> : null}
              <span className="welcome-option-note fig">
                {manual
                  ? ''
                  : disabled
                    ? `about ${count(o.searchesPerMonth)} a month, more than fits your ${count(rec.usable)}`
                    : `about ${count(o.searchesPerMonth)} a month`}
              </span>
            </label>
          );
        })}
      </fieldset>

      <p className="welcome-sum" role="status">
        {chosen.id === 'manual' ? (
          <>
            <strong>Scans run only when you press Scan now.</strong> {rec.arithmetic}
          </>
        ) : (
          <>
            <strong className="fig">
              {count(chosen.scansPerMonth)} scans × {plural(rec.perScan, 'search', 'searches')} = about {count(chosen.searchesPerMonth)} a month.
            </strong>{' '}
            Your plan gives <span className="fig">{count(rec.usable + plan.settings.settings.reserve)}</span>, your reserve keeps <span className="fig">{count(plan.settings.settings.reserve)}</span>, so{' '}
            <span className="fig">{count(rec.usable)}</span> are left. {basisSentence(rec, hasKeepa)} These are estimates.
          </>
        )}
      </p>

      <div className="welcome-switches">
        <Switch
          label="Open at login"
          help={`Scans only run while Split Finder is open. It then starts when you sign in to this ${words.computer}.`}
          checked={plan.login}
          onChange={(login) => set({ login })}
        />
        <Switch
          label="Keep the computer awake while a scan runs"
          help={`Only while a scan runs. The screen can still turn off.`}
          checked={plan.awake}
          onChange={(awake) => set({ awake })}
        />
      </div>
    </>
  );
}

/** The sentence after Turn on, naming what runs next. */
export function turnedOnSentence(plan: RunPlan): string {
  const o = plan.rec.options.find((x) => x.id === plan.schedule)!;
  return o.id === 'manual'
    ? 'Scans run only when you press Scan now. You can choose a schedule later in Settings.'
    : `Turned on: ${o.label}. The first scan runs at the next slot, not now. You can change this in Settings.`;
}

/** The step Settings (or Help) wants the sheet to open at; read once when the sheet opens. */
let wanted: 'run' | null = null;
export function wantRunStep(): void {
  wanted = 'run';
}
export function takeWantedStep(): 'run' | null {
  const w = wanted;
  wanted = null;
  return w;
}
