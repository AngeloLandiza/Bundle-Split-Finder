import type { Schedule } from '../../../core/src/schedule';
import type { AppState } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import './FirstRun.css';

const SIGN_UP = 'https://serpapi.com/users/sign_up';

/** "DEWALT", "DEWALT and RYOBI", "A, B and C". */
function list(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function schedulePhrase(s: Schedule): string {
  if (s.mode === 'manual') return 'scanning only when you click';
  if (s.mode === 'interval') return `scanning every ${s.hours} ${s.hours === 1 ? 'hour' : 'hours'}`;
  return `scanning daily at ${s.at}`;
}

/** The first-run body, shown before a key is saved. Nothing here can spend a search; the shell draws the header. */
export function FirstRun({ state, openSettings }: { state: AppState; api: WorkerApi; openSettings: () => void }) {
  const brands = list(state.settings.brands);
  const later: { title: string; text: string }[] = [
    {
      title: 'Choose brands and how often to scan',
      text: brands === '' ? 'Starts with no brands yet.' : `Starts with ${brands}, ${schedulePhrase(state.settings.schedule)}.`,
    },
    { title: 'Run your first scan', text: 'A scan never spends more searches than the limit you set.' },
  ];
  return (
    <div className="firstrun">
      <div className="firstrun-intro">
        <h1 className="firstrun-title">Find bundles worth splitting</h1>
        <p className="firstrun-lead">
          {`Split Finder checks Home Depot for ${brands === '' ? '' : `${brands} `}bundles, matches each part to its Amazon listing, and ranks the bundles by estimated profit.`}
        </p>
      </div>
      <ol className="firstrun-steps">
        <li className="firstrun-step" aria-current="step">
          <span className="firstrun-num" data-current="true">1</span>
          <div className="firstrun-step-body">
            <div>
              <div className="firstrun-step-title">Add your SerpApi key</div>
              <div className="firstrun-step-text">The free plan gives 250 searches a month. Your key stays in this browser.</div>
            </div>
            <div className="firstrun-actions">
              <button type="button" className="btn btn-primary" onClick={openSettings}>
                Open settings
              </button>
              <a className="firstrun-link" href={SIGN_UP} target="_blank" rel="noopener noreferrer">
                Get a free key
              </a>
            </div>
          </div>
        </li>
        {later.map((s, i) => (
          <li className="firstrun-step" key={s.title}>
            <span className="firstrun-num">{i + 2}</span>
            <div className="firstrun-step-body">
              <div>
                <div className="firstrun-step-title firstrun-later">{s.title}</div>
                <div className="firstrun-step-text">{s.text}</div>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <p className="firstrun-note">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.25v3.5M8 5.1v.1" />
        </svg>
        <span>
          Opening a bundle on homedepot.com is free. Split Finder reads the page you are on and only uses a search to look up a part on Amazon.
        </span>
      </p>
    </div>
  );
}
