import { api, useAction, useApp } from '../api/hooks';
import { Button } from '../components/Button';
import { AppNotices } from '../components/Page';
import { PairingNotices } from '../components/PairingNotice';
import { StatusLine } from '../components/StatusLine';
import { plural } from '../lib/format';
import { InstallHelper, KeyField } from './Settings';
import './FirstRun.css';

/**
 * The one-time setup: connect Chrome, add the SerpApi key, run the first scan. It is shown until
 * the first scan finishes (or he skips it) and never again; Today is the landing page after.
 */
export function FirstRun({ onSkip }: { onSkip: () => void }) {
  const { state, refreshState, online, pairing } = useApp();
  const scan = useAction(api.scan);
  if (!state) return null;
  const paired = state.helper.paired;
  const keyed = state.keys.serpapi;
  const running = state.agent.status === 'scanning';
  const step = !paired ? 1 : !keyed ? 2 : 3;
  const brands = 'DEWALT and RYOBI';

  return (
    <div className="firstrun view-enter">
      <header className="firstrun-head">
        <h1 className="page-title" tabIndex={-1}>
          Set up Split Finder
        </h1>
        <p>
          The agent checks Home Depot for discounted {brands} bundles, matches each part to its Amazon listing, and messages you when a deal is worth a look. Three steps, once.
        </p>
      </header>
      {!online ? <AppNotices /> : pairing.requests.length ? <div className="notices"><PairingNotices /></div> : null}
      <ol className="frsteps">
        <li className="frstep" aria-current={step === 1 ? 'step' : undefined}>
          <span className="frnum fig">1</span>
          <div className="frbody">
            <h2>Connect Chrome{paired ? <span className="frdone"> · done</span> : null}</h2>
            {paired ? (
              <p>Chrome is connected. It reads Home Depot pages for the agent while it is open.</p>
            ) : (
              <>
                <p>In Chrome, open the Split Finder side panel and press Connect to the app. Chrome then asks here; check that the code matches and allow it.</p>
                <InstallHelper />
              </>
            )}
          </div>
        </li>
        <li className="frstep" aria-current={step === 2 ? 'step' : undefined}>
          <span className="frnum fig">2</span>
          <div className="frbody">
            <h2>Add your SerpApi key{keyed ? <span className="frdone"> · done</span> : null}</h2>
            <p>The free plan has 250 searches a month. The key stays in the agent on this Mac.</p>
            <KeyField
              name="serpapi"
              label="SerpApi key"
              help={
                <a href="https://serpapi.com/users/sign_up" target="_blank" rel="noopener noreferrer">
                  Get a free key at serpapi.com
                </a>
              }
            />
            <p className="frquiet">Keepa, Anthropic and eBay keys are optional; add them in Settings later.</p>
          </div>
        </li>
        <li className="frstep" aria-current={step === 3 ? 'step' : undefined}>
          <span className="frnum fig">3</span>
          <div className="frbody">
            <h2>Run the first scan</h2>
            <p>A scan never spends more searches than the limit in Settings. It takes a few minutes; Chrome stays open meanwhile.</p>
            {running ? (
              <StatusLine agent={state.agent} />
            ) : (
              <div className="fractions">
                <Button variant="primary" disabled={step !== 3} busy={scan.busy} busyLabel="Starting…" onClick={() => void scan.run().then(refreshState)} cost={state.budget.serpPerScan > 0 ? plural(state.budget.serpPerScan, 'search', 'searches') : undefined}>
                  Scan now
                </Button>
              </div>
            )}
            {scan.error ? <p role="alert">{scan.error}</p> : null}
          </div>
        </li>
      </ol>
      <div className="frfoot">
        <Button variant="quiet" size="sm" onClick={onSkip}>
          Skip setup for now
        </Button>
      </div>
    </div>
  );
}
