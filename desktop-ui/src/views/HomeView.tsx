import type { Schedule } from '@core/schedule';
import { useCallback, useEffect, useState } from 'react';
import { api, type SetupStatus } from '../api';

const SIGN_UP = 'https://serpapi.com/users/sign_up';

function list(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function schedulePhrase(s: Schedule): string {
  if (s.mode === 'manual') return 'scanning only when you click';
  if (s.mode === 'interval') return `scanning every ${s.hours} ${s.hours === 1 ? 'hour' : 'hours'}`;
  return `scanning daily at ${s.at}`;
}


export function HomeView({
  keySet,
  onOpenSettings,
  onScan,
}: {
  keySet: boolean;
  onOpenSettings: () => void;
  onScan: () => void;
}) {
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [brands, setBrands] = useState(['DEWALT', 'RYOBI']);
  const [schedule, setSchedule] = useState<Schedule>({ mode: 'manual' });

  const load = useCallback(() => {
    void api.setup().then((s) => setSetup(s));
    void api.settings().then((s) => {
      if (!s.ok || !s.settings) return;
      if (s.settings.brands?.length) setBrands(s.settings.brands);
      if (s.settings.schedule) setSchedule(s.settings.schedule);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const brandLine = list(brands);
  const helperReady = setup?.extensionReady === true;
  const step = !helperReady ? 1 : !keySet ? 2 : 3;

  return (
    <div className="firstrun">
      <div className="firstrun-intro">
        <h1 className="firstrun-title">Find bundles worth splitting</h1>
        <p className="firstrun-lead">
          {`Split Finder checks Home Depot for ${brandLine} bundles, matches each part to its Amazon listing, and ranks bundles by estimated profit.`}
        </p>
      </div>
      <ol className="firstrun-steps">
        <li className="firstrun-step" aria-current={step === 1 ? 'step' : undefined}>
          <span className="firstrun-num" data-current={step === 1 ? 'true' : undefined}>
            1
          </span>
          <div className="firstrun-step-body">
            <div>
              <div className={`firstrun-step-title${step > 1 ? ' firstrun-later' : ''}`}>Install the browser helper</div>
              <div className="firstrun-step-text">
                Chrome reads Home Depot bundle pages locally. The app unpacks a helper folder you load once.
              </div>
            </div>
            <div className="firstrun-actions">
              <button
                type="button"
                className="btn"
                disabled={!setup?.zipAvailable || helperReady}
                onClick={() => {
                  void api.installHelper().then((r) => {
                    if (r.ok) load();
                  });
                }}
              >
                Install helper folder
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => window.open('chrome://extensions/', '_blank')}>
                Open Chrome extensions
              </button>
            </div>
            {setup?.extensionDir ? (
              <p className="firstrun-step-text mono" style={{ wordBreak: 'break-all' }}>
                {setup.extensionDir}
              </p>
            ) : null}
          </div>
        </li>
        <li className="firstrun-step" aria-current={step === 2 ? 'step' : undefined}>
          <span className="firstrun-num" data-current={step === 2 ? 'true' : undefined}>
            2
          </span>
          <div className="firstrun-step-body">
            <div>
              <div className={`firstrun-step-title${step > 2 ? ' firstrun-later' : ''}`}>Add your SerpApi key</div>
              <div className="firstrun-step-text">The free plan includes 250 searches a month. Keys sync to the helper within a minute.</div>
            </div>
            <div className="firstrun-actions">
              <button type="button" className="btn" onClick={onOpenSettings}>
                Open settings
              </button>
              <a className="firstrun-link" href={SIGN_UP} target="_blank" rel="noopener noreferrer">
                Get a free key
              </a>
            </div>
          </div>
        </li>
        <li className="firstrun-step" aria-current={step === 3 ? 'step' : undefined}>
          <span className="firstrun-num" data-current={step === 3 ? 'true' : undefined}>
            3
          </span>
          <div className="firstrun-step-body">
            <div>
              <div className={`firstrun-step-title${step < 3 ? ' firstrun-later' : ''}`}>Run your first scan</div>
              <div className="firstrun-step-text">
                {keySet
                  ? `Starts with ${brandLine}, ${schedulePhrase(schedule)}. Keep Chrome open with the helper loaded.`
                  : 'A scan never spends more searches than the limit you set.'}
              </div>
            </div>
            {step === 3 ? (
              <button type="button" className="btn" onClick={onScan}>
                Scan now
              </button>
            ) : null}
          </div>
        </li>
      </ol>
      <p className="firstrun-note">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.25v3.5M8 5.1v.1" />
        </svg>
        <span>
          Searches find bundles on Home Depot and parts on Amazon. Each bundle&apos;s own page is read in your browser, free.
        </span>
      </p>
    </div>
  );
}