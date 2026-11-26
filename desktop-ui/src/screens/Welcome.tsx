import { useState } from 'react';
import { api, useAction, useApp } from '../api/hooks';
import appIcon from '../../../desktop/icon/app-icon.svg';
import { Button } from '../components/Button';
import { Glyph } from '../components/Glyph';
import { PairingNotices } from '../components/PairingNotice';
import { Sheet, SheetActions } from '../components/Sheet';
import { Notice } from '../components/States';
import { StatusLine } from '../components/StatusLine';
import { CONNECT_BUTTON_LABEL } from '@core/api/labels';
import { plural } from '../lib/format';
import { scanSpend } from '../lib/scanSpend';
import { agentDownHint } from '../lib/agentDown';
import { acrossWords, perKeySplit } from '../lib/keyEntries';
import { words } from '../lib/platform';
import { setupProgress, type SetupStepId } from '../lib/setup';
import { InstallHelper, KeyField } from '../components/SetupParts';
import { NO_CHOICE, RunStep, takeWantedStep, turnedOnSentence, useRunPlan, type RunChoice } from './WelcomeRun';
import './Welcome.css';

type StepId = SetupStepId | 'run';

const STEPS: { id: StepId; title: string; short: string }[] = [
  { id: 'chrome', title: 'Connect Chrome', short: 'Chrome' },
  { id: 'key', title: 'Add your SerpApi key', short: 'SerpApi key' },
  { id: 'scan', title: 'Run the first scan', short: 'First scan' },
  { id: 'run', title: 'Let it run by itself', short: 'Run by itself' },
];

/** The app's own icon (desktop/icon/app-icon.svg, the one the Dock and the installer use), for the sheet's header. */
export function AppMark({ size = 64 }: { size?: number }) {
  return <img className="app-mark" src={appIcon} width={size} height={size} alt="" />;
}

/**
 * The welcome sheet (design.md, Desktop app > Sheet): four short steps over the live app, which stays
 * usable behind it. The fourth, "Let it run by itself", turns on a schedule the account can pay for. Skip for now closes it; "Finish setup" in the sidebar or Help > Finish setup opens it
 * again at the first step still open. Nothing here blocks the app.
 */
export function WelcomeSheet({ onClose }: { onClose: () => void }) {
  const { state, online, pairing, refreshState } = useApp();
  const progress = state ? setupProgress(state) : null;
  // Opens at the first step still open; when the three are done, or Settings asked for it, at the schedule.
  const [index, setIndex] = useState(() => {
    const at = takeWantedStep() ?? (progress?.complete ? 'run' : (progress?.current ?? 'chrome'));
    return Math.max(0, STEPS.findIndex((s) => s.id === at));
  });
  const scan = useAction(api.scan);
  const [choice, setChoice] = useState<RunChoice>(NO_CHOICE);
  const { plan, failed } = useRunPlan(choice);
  const [turnedOn, setTurnedOn] = useState<string | null>(null);
  const turnOn = useAction(async () => {
    if (!plan) return;
    const schedule = plan.rec.options.find((o) => o.id === plan.schedule)!.schedule;
    await api.patchSettings({ settings: { schedule }, shell: { launchAtLogin: plan.login, keepAwakeDuringScan: plan.awake } });
    setTurnedOn(turnedOnSentence(plan));
    refreshState();
  });
  const step = STEPS[index]!;
  const done = (id: StepId) => (id === 'run' ? turnedOn !== null || (plan !== null && plan.settings.settings.schedule.mode !== 'manual') : (progress?.steps.find((s) => s.id === id)?.done ?? false));
  const last = index === STEPS.length - 1;
  const running = state?.agent.status === 'scanning';

  const footer = (
    <SheetActions
      lead={
        turnedOn !== null ? null : (
          <Button variant="quiet" size="lg" onClick={onClose}>
            Skip for now
          </Button>
        )
      }
      secondary={
        index > 0 ? (
          <Button size="lg" onClick={() => setIndex(index - 1)}>
            Back
          </Button>
        ) : null
      }
      primary={
        last ? (
          turnedOn !== null ? (
            <Button variant="primary" size="lg" onClick={onClose} data-autofocus="">
              Done
            </Button>
          ) : (
            <Button variant="primary" size="lg" disabled={!plan || !online} busy={turnOn.busy} busyLabel="Turning on…" onClick={() => void turnOn.run()} data-autofocus="">
              Turn on
            </Button>
          )
        ) : (
          <Button variant="primary" size="lg" onClick={() => setIndex(index + 1)} data-autofocus="">
            Continue
          </Button>
        )
      }
    />
  );

  return (
    <Sheet label="Set up Split Finder" onCancel={onClose} footer={footer}>
      <header className="welcome-head">
        <AppMark />
        <div>
          <h1 className="t-title">Welcome to Split Finder</h1>
          <p className="welcome-lead">
            The agent finds discounted DEWALT and RYOBI bundles on Home Depot, matches each part to its Amazon listing, and tells you which are worth a look. Four steps, once. You can use the app while you set it up.
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
            {agentDownHint(words)} The steps continue once it runs.
          </Notice>
        ) : null}

        {step.id === 'chrome' ? (
          done('chrome') ? (
            <Done text="Chrome is connected. It reads Home Depot pages for the agent while it is open." />
          ) : (
            <>
              <p>Install the helper, then in Chrome open the Split Finder side panel and press {CONNECT_BUTTON_LABEL}. Chrome then asks here: check that the code matches and allow it.</p>
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
            {/* Key stacking: with more than one key, how many and each one's searches left (the totals are what a scan spends). */}
            {done('key') ? <Done text={acrossWords(state, 'serpapi') ? `Your SerpApi keys are saved in the agent on this ${words.computer}, ${acrossWords(state, 'serpapi')}${perKeySplit(state, 'serpapi') ? ` (searches left: ${perKeySplit(state, 'serpapi')})` : ''}.` : `Your SerpApi key is saved in the agent on this ${words.computer}.`} /> : <p>The free plan has 250 searches a month. The key stays in the agent on this {words.computer} and is sent only to SerpApi.</p>}
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
            {done('scan') && !running ? <Done text="The first scan has run. Its deals are in Today and Deals." /> : <p>{scanSpend(state.budget).sentence} It takes a few minutes; keep Chrome open meanwhile.</p>}
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
                  cost={scanSpend(state.budget).cost}
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

        {step.id === 'run' ? (
          <>
            {!state?.keys.serpapi && turnedOn === null ? (
              <Notice tone="attention" title="No SerpApi key yet.">
                Scheduled scans need it. Turn the schedule on now and add the key in the second step, or choose Skip for now.
              </Notice>
            ) : null}
            <RunStep plan={plan} failed={failed} choice={choice} onChoose={setChoice} saved={turnedOn} />
            {turnOn.error ? (
              <p className="welcome-error" role="alert">
                {turnOn.error}
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
