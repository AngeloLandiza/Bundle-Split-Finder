import { useState } from 'react';
import { api, useAction, useApp } from '../api/hooks';
import { Button } from '../components/Button';
import { Glyph } from '../components/Glyph';
import { PairingNotices } from '../components/PairingNotice';
import { Sheet } from '../components/Sheet';
import { Notice } from '../components/States';
import { StatusLine } from '../components/StatusLine';
import { plural } from '../lib/format';
import { setupProgress, type SetupStepId } from '../lib/setup';
import { InstallHelper, KeyField } from './Settings';
import './Welcome.css';

const STEPS: { id: SetupStepId; title: string; short: string }[] = [
  { id: 'chrome', title: 'Connect Chrome', short: 'Chrome' },
  { id: 'key', title: 'Add your SerpApi key', short: 'SerpApi key' },
  { id: 'scan', title: 'Run the first scan', short: 'First scan' },
];

/** The app's mark in an app-icon tile, for the sheet's header. */
export function AppMark({ size = 56 }: { size?: number }) {
  return (
    <span className="app-mark" style={{ inlineSize: size, blockSize: size }} aria-hidden="true">
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 20 20">
        <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 2.75h4.75a2.5 2.5 0 0 1 2.5 2.5v9.5a2.5 2.5 0 0 1-2.5 2.5H10z" fill="currentColor" />
      </svg>
    </span>
  );
}

/**
 * The welcome sheet (design.md, Desktop app > Sheet): three short steps over the live app, which stays
 * usable behind it. Skip for now closes it; "Finish setup" in the sidebar or Help > Finish setup opens it
 * again at the first step still open. Nothing here blocks the app.
 */
export function WelcomeSheet({ onClose }: { onClose: () => void }) {
  const { state, online, pairing, refreshState } = useApp();
  const progress = state ? setupProgress(state) : null;
  const [index, setIndex] = useState(() => Math.max(0, STEPS.findIndex((s) => s.id === (progress?.current ?? 'chrome'))));
  const scan = useAction(api.scan);
  const step = STEPS[index]!;
  const done = (id: SetupStepId) => progress?.steps.find((s) => s.id === id)?.done ?? false;
  const last = index === STEPS.length - 1;
  const running = state?.agent.status === 'scanning';

  const footer = (
    <>
      <Button variant="quiet" size="lg" onClick={onClose}>
        Skip for now
      </Button>
      <span className="welcome-foot-space" />
      {index > 0 ? (
        <Button size="lg" onClick={() => setIndex(index - 1)}>
          Back
        </Button>
      ) : null}
      {last ? (
        <Button variant="primary" size="lg" onClick={onClose} data-autofocus="">
          {done('scan') || running ? 'Done' : 'Close'}
        </Button>
      ) : (
        <Button variant="primary" size="lg" onClick={() => setIndex(index + 1)} data-autofocus="">
          Continue
        </Button>
      )}
    </>
  );

  return (
    <Sheet label="Set up Split Finder" onCancel={onClose} footer={footer}>
      <header className="welcome-head">
        <AppMark />
        <div>
          <h1 className="t-title">Welcome to Split Finder</h1>
          <p className="welcome-lead">
            The agent finds discounted DEWALT and RYOBI bundles on Home Depot, matches each part to its Amazon listing, and tells you which are worth a look. Three steps, once. You can use the app while you set it up.
          </p>
        </div>
      </header>

      <ol className="welcome-steps" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s.id}>
            <button type="button" className="welcome-step" aria-current={i === index ? 'step' : undefined} onClick={() => setIndex(i)}>
              <span className={`welcome-dot${done(s.id) ? ' welcome-dot-done' : ''}`}>{done(s.id) ? <Glyph name="check" size={10} /> : <span className="fig">{i + 1}</span>}</span>
              <span className="welcome-step-title">{s.short}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="sr-only" aria-live="polite">
        Step {index + 1} of {STEPS.length}: {step.title}
        {done(step.id) ? ', done' : ''}
      </p>

      <section className="welcome-pane" aria-labelledby="welcome-step-title">
        <h2 className="t-headline" id="welcome-step-title">
          {step.title}
        </h2>
        {!online ? (
          <Notice tone="attention" title="The agent is not running.">
            Open Split Finder from the menu bar; the steps continue once it runs.
          </Notice>
        ) : null}

        {step.id === 'chrome' ? (
          done('chrome') ? (
            <Done text="Chrome is connected. It reads Home Depot pages for the agent while it is open." />
          ) : (
            <>
              <p>Install the helper, then in Chrome open the Split Finder side panel and press Connect to the app. Chrome then asks here: check that the code matches and allow it.</p>
              {pairing.requests.length ? (
                <div className="inset-notices">
                  <PairingNotices />
                </div>
              ) : null}
              <InstallHelper />
            </>
          )
        ) : null}

        {step.id === 'key' ? (
          <>
            {done('key') ? <Done text="Your SerpApi key is saved in the agent on this Mac." /> : <p>The free plan has 250 searches a month. The key stays in the agent on this Mac and is sent only to SerpApi.</p>}
            <KeyField
              name="serpapi"
              label="SerpApi key"
              help={
                <a href="https://serpapi.com/users/sign_up" target="_blank" rel="noopener noreferrer">
                  Get a free key at serpapi.com
                </a>
              }
            />
            <p className="welcome-quiet">Keepa, Anthropic and eBay keys are optional; add them in Settings later.</p>
          </>
        ) : null}

        {step.id === 'scan' && state ? (
          <>
            {done('scan') && !running ? <Done text="The first scan has run. Its deals are in Today and Deals." /> : <p>A scan never spends more searches than the limit in Settings. It takes a few minutes; keep Chrome open meanwhile.</p>}
            {running ? (
              <div className="welcome-status">
                <StatusLine agent={state.agent} />
              </div>
            ) : (
              <div className="welcome-actions">
                <Button
                  variant={done('scan') ? 'secondary' : 'primary'}
                  disabled={!state.keys.serpapi || !online}
                  busy={scan.busy}
                  busyLabel="Starting…"
                  onClick={() => void scan.run().then(refreshState)}
                  cost={state.budget.serpPerScan > 0 ? plural(state.budget.serpPerScan, 'search', 'searches') : undefined}
                >
                  {done('scan') ? 'Scan again' : 'Scan now'}
                </Button>
                {!state.keys.serpapi ? <span className="welcome-quiet">Add the SerpApi key first.</span> : null}
              </div>
            )}
            {scan.error ? (
              <p className="welcome-error" role="alert">
                {scan.error}
              </p>
            ) : null}
          </>
        ) : null}
      </section>
    </Sheet>
  );
}

function Done({ text }: { text: string }) {
  return (
    <p className="welcome-done">
      <Glyph name="check" size={14} />
      {text}
    </p>
  );
}
