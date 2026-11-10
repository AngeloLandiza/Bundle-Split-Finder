import { useState } from 'react';
import { forecastUsage, runsPerMonth, type Schedule } from '@core/schedule';
import type { ExtensionSettings, SettingsField } from '@core/settings';
import { NumberField, Section } from './fields';

type Option = 'manual' | 'six' | 'twelve' | 'daily' | 'every';
type Problems = Partial<Record<SettingsField, string>>;

const n = (v: number): string => v.toLocaleString('en-US');

function optionOf(s: Schedule): Option {
  if (s.mode === 'manual') return 'manual';
  if (s.mode === 'daily') return 'daily';
  if (s.hours === 6) return 'six';
  if (s.hours === 12) return 'twelve';
  return 'every';
}

interface Props {
  draft: ExtensionSettings;
  problems: Problems;
  planPerMonth: number;
  onChange(patch: Partial<ExtensionSettings>): void;
}

export function ScanningSection({ draft, problems, planPerMonth, onChange }: Props) {
  const [option, setOption] = useState<Option>(optionOf(draft.schedule));
  // Remembered so that switching between options does not lose what was typed.
  const [at, setAt] = useState(draft.schedule.mode === 'daily' ? draft.schedule.at : '07:00');
  const [hours, setHours] = useState(draft.schedule.mode === 'interval' ? draft.schedule.hours : 24);

  const choose = (next: Option) => {
    setOption(next);
    const schedule: Schedule =
      next === 'manual'
        ? { mode: 'manual' }
        : next === 'six'
          ? { mode: 'interval', hours: 6 }
          : next === 'twelve'
            ? { mode: 'interval', hours: 12 }
            : next === 'daily'
              ? { mode: 'daily', at }
              : { mode: 'interval', hours };
    onChange({ schedule });
  };

  const scheduleError = problems.schedule;
  const radio = (value: Option, label: string) => (
    <label className="choice">
      <input type="radio" name="freq" checked={option === value} onChange={() => choose(value)} />
      {label}
    </label>
  );

  return (
    <Section
      title="Scanning"
      help="How often Split Finder checks for bundles, and how many searches a scan may use. Scans run while Chrome is open."
    >
      <fieldset className="group">
        <legend>Scan for bundles</legend>
        {radio('manual', 'Only when I click Scan now')}
        {radio('six', 'Every 6 hours')}
        {radio('twelve', 'Every 12 hours')}
        <div className="choice-row">
          {radio('daily', 'Once a day at')}
          <input
            type="time"
            className="input input--small figure"
            aria-label="Time of the daily scan"
            value={option === 'daily' && draft.schedule.mode === 'daily' ? draft.schedule.at : at}
            aria-invalid={option === 'daily' && scheduleError ? true : undefined}
            aria-describedby={option === 'daily' && scheduleError ? 'error-schedule' : undefined}
            onChange={(e) => {
              setAt(e.target.value);
              if (option !== 'daily') setOption('daily');
              onChange({ schedule: { mode: 'daily', at: e.target.value } });
            }}
          />
        </div>
        <div className="choice-row">
          {radio('every', 'Every')}
          <NumberField
            id="interval-hours"
            label="Hours between scans"
            ariaLabel="Hours between scans"
            inline
            width={72}
            min={1}
            max={168}
            value={draft.schedule.mode === 'interval' && option === 'every' ? draft.schedule.hours : hours}
            invalid={option === 'every' && Boolean(scheduleError)}
            describedBy={option === 'every' && scheduleError ? 'error-schedule' : undefined}
            onChange={(h) => {
              setHours(h);
              if (option !== 'every') setOption('every');
              onChange({ schedule: { mode: 'interval', hours: h } });
            }}
          />
          <span>hours</span>
        </div>
        {scheduleError ? (
          <p id="error-schedule" className="field-error">
            {scheduleError}
          </p>
        ) : null}
      </fieldset>

      <div className="row row--wide">
        <NumberField
          id="perscan"
          label="Searches per scan, at most"
          width={120}
          min={1}
          max={250}
          value={draft.searchesPerScan}
          invalid={Boolean(problems.searchesPerScan)}
          error={problems.searchesPerScan}
          onChange={(v) => onChange({ searchesPerScan: v })}
        />
        <NumberField
          id="reserve"
          label="Always keep in reserve"
          width={120}
          min={0}
          max={250}
          value={draft.reserve}
          invalid={Boolean(problems.reserve)}
          error={problems.reserve}
          onChange={(v) => onChange({ reserve: v })}
        />
      </div>

      <Forecast draft={draft} problems={problems} planPerMonth={planPerMonth} />
    </Section>
  );
}

function Forecast({ draft, problems, planPerMonth }: { draft: ExtensionSettings; problems: Problems; planPerMonth: number }) {
  if (problems.schedule || problems.searchesPerScan || problems.reserve) {
    return (
      <div className="forecast" data-testid="forecast">
        <span className="forecast-title">Fix the fields marked above to see what this schedule uses.</span>
      </div>
    );
  }

  const { schedule, searchesPerScan, reserve } = draft;
  const usable = Math.max(0, planPerMonth - reserve);

  if (schedule.mode === 'manual') {
    return (
      <div className="forecast" data-testid="forecast">
        <span className="forecast-title">Scans run only when you click Scan now</span>
        <div className="forecast-note">
          Nothing is spent automatically. A scan you start can use up to <span className="figure small">{n(searchesPerScan)}</span>{' '}
          searches, and it may use the reserve.
        </div>
      </div>
    );
  }

  const f = forecastUsage(schedule, searchesPerScan, planPerMonth, reserve);
  const runs = runsPerMonth(schedule);
  const scheduledPct = planPerMonth > 0 ? Math.min(100, (f.searchesPerMonth / planPerMonth) * 100) : 0;
  const reservePct = planPerMonth > 0 ? Math.min(100 - scheduledPct, (reserve / planPerMonth) * 100) : 0;

  return (
    <div className="forecast" data-testid="forecast" data-attention={f.fitsPlan ? undefined : 'true'}>
      {f.fitsPlan ? (
        <div className="forecast-head">
          <span className="forecast-title">This fits your plan</span>
          <span className="figure small">
            {n(f.searchesPerMonth)} of {n(usable)} usable a month
          </span>
        </div>
      ) : (
        <div className="forecast-title" role="alert">
          This needs <span className="figure small">{n(f.searchesPerMonth)}</span> searches a month and your plan has{' '}
          <span className="figure small">{n(usable)}</span> to spend. Use{' '}
          <span className="figure small">{n(f.maxPerRunThatFits)}</span> per scan, or scan less often.
        </div>
      )}
      <div
        className="meter"
        role="img"
        aria-label={`Scheduled scans use up to ${n(f.searchesPerMonth)} searches, ${n(reserve)} are held in reserve, of ${n(planPerMonth)} in the plan`}
      >
        <span className="meter-used" style={{ width: `${scheduledPct}%` }} />
        <span className="meter-reserve" style={{ width: `${reservePct}%` }} />
      </div>
      <div className="legend">
        <span>
          <i className="swatch swatch--used" />
          Scheduled scans, up to {n(f.searchesPerMonth)}
        </span>
        <span>
          <i className="swatch swatch--reserve" />
          Reserve, {n(reserve)}
        </span>
      </div>
      <div className="forecast-note">
        <span className="figure small">{n(runs)}</span> scans a month × <span className="figure small">{n(searchesPerScan)}</span>{' '}
        searches. Lookups you start yourself come out of the reserve.
      </div>
    </div>
  );
}
