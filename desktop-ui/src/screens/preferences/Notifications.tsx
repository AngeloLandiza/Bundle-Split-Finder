import { useState } from 'react';
import { api, useAction, useApp } from '../../api/hooks';
import { Button } from '../../components/Button';
import { Select, Switch, TextField } from '../../components/Fields';
import { Glyph } from '../../components/Glyph';
import { RULES, isClock } from '../../lib/prefs';
import { Inline, NumberField, Pane, Row, Rule, usePrefs } from './form';

type Digest = 'each-run' | 'morning' | 'off';

/** A time of day, saved only once it is a whole 24-hour time. */
function ClockField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <TextField
      label={<span className="sr-only">{label}</span>}
      type="time"
      mono
      width="sm"
      value={value}
      status={error ? { tone: 'error', text: error } : null}
      onChange={(e) => {
        if (!isClock(e.target.value)) {
          setError(`${label}: use a 24-hour time such as 08:00.`);
          return;
        }
        setError(null);
        onCommit(e.target.value);
      }}
    />
  );
}

export function NotificationsPane() {
  const { settings, update, goTo } = usePrefs();
  const { state } = useApp();
  const n = settings.notifications;
  const a = settings.alerts;
  const test = useAction(api.testNotification);
  const [sent, setSent] = useState(false);
  const setKind = (kind: keyof typeof n.kinds, on: boolean) => update({ notifications: { kinds: { [kind]: on } } });
  const telegram = state?.keys.telegram ?? false;

  return (
    <Pane>
      <Row label="Tell me when" align="start" help="Each kind is a notification on this Mac. Turn a kind off and it is not sent at all.">
        <div className="stack">
          <Switch label="Something needs your answer" checked={n.kinds.review} onChange={(on) => setKind('review', on)} />
          <Switch
            label="A deal is worth buying"
            checked={n.kinds.deal && a.enabled}
            onChange={(on) => update({ notifications: { kinds: { deal: on } }, alerts: { enabled: on } })}
          />
          <Switch label="Autopilot applied an answer" checked={n.kinds.autopilot} onChange={(on) => setKind('autopilot', on)} />
          <Switch label="A scan finished" checked={n.kinds.scan} onChange={(on) => setKind('scan', on)} />
          <Switch label="Something went wrong" checked={n.kinds.error} onChange={(on) => setKind('error', on)} />
        </div>
      </Row>
      <Rule />
      <Row label="Deals worth buying now" align="start" help="Profit and ROI are estimates from your fee settings. A deal is called worth buying now when it clears all three figures below.">
      </Row>
      <Row label="ROI at least">
        <NumberField label="ROI at least" value={a.minRoiPercent} rule={RULES.minRoiPercent} suffix="%" onCommit={(minRoiPercent) => update({ alerts: { minRoiPercent } }, { delay: 600 })} />
      </Row>
      <Row label="Estimated profit at least">
        <NumberField label="Estimated profit at least" value={a.minProfit} rule={RULES.minProfit} prefix="$" step="0.5" onCommit={(minProfit) => update({ alerts: { minProfit } }, { delay: 600 })} />
      </Row>
      <Row label="Sold a month at least" help="Units the slowest part sold on Amazon last month, by Keepa. Keepa leaves the figure out for slow sellers, so a part without one reads as no sales data and the deal is not called worth buying now.">
        <NumberField label="Sold a month at least" value={a.minMonthlySold ?? 50} rule={RULES.minMonthlySold} onCommit={(minMonthlySold) => update({ alerts: { minMonthlySold } }, { delay: 600 })} />
      </Row>
      <Row label="Profit floor" align="start" help="A deal you are watching whose estimated profit falls below this is reported as margin fell. Empty uses the profit figure above.">
        <div className="stack">
          <NumberField
            label="Profit floor"
            value={a.floorProfit ?? Number.NaN}
            rule={RULES.floorProfit}
            prefix="$"
            step="0.5"
            onCommit={(floorProfit) => update({ alerts: { floorProfit } }, { delay: 600 })}
            onClear={() => update({ alerts: { floorProfit: null as unknown as number } }, { delay: 600 })}
          />
          <Switch label="Include margin fell in the digest" checked={a.marginDownDigest ?? false} onChange={(marginDownDigest) => update({ alerts: { marginDownDigest } })} />
        </div>
      </Row>
      <Row label="Open questions" align="start">
        <Switch label="Also tell me when questions wait in Review" checked={a.reviewDigest} onChange={(reviewDigest) => update({ alerts: { reviewDigest } })} />
      </Row>
      <Rule />
      <Row label="Digest" align="start" help="After each scan sends one summary when it ends. Once a morning holds deal, question and Autopilot lines until then. Off sends no digest, to Telegram too.">
        <div className="stack">
          <Select label={<span className="sr-only">Digest</span>} value={n.digest} width="md" onChange={(e) => update({ notifications: { digest: e.target.value as Digest } })}>
            <option value="each-run">After each scan</option>
            <option value="morning">Once a morning</option>
            <option value="off">Off</option>
          </Select>
          {n.digest === 'morning' ? (
            <Inline>
              <span>At</span>
              <ClockField label="Morning digest time" value={n.morningAt} onCommit={(morningAt) => update({ notifications: { morningAt } }, { delay: 600 })} />
            </Inline>
          ) : null}
        </div>
      </Row>
      <Row label="Quiet hours" align="start" help="Notifications wait and arrive as one digest when quiet hours end. Scan finished ones are dropped.">
        <div className="stack">
          <Switch label={n.quietHours.enabled ? 'On' : 'Off'} checked={n.quietHours.enabled} onChange={(enabled) => update({ notifications: { quietHours: { enabled } } })} />
          {n.quietHours.enabled ? (
            <Inline>
              <span>From</span>
              <ClockField label="Quiet hours start" value={n.quietHours.from} onCommit={(from) => update({ notifications: { quietHours: { from } } }, { delay: 600 })} />
              <span>to</span>
              <ClockField label="Quiet hours end" value={n.quietHours.to} onCommit={(to) => update({ notifications: { quietHours: { to } } }, { delay: 600 })} />
            </Inline>
          ) : null}
        </div>
      </Row>
      <Rule />
      <Row label="Telegram" align="start" help="The same digest, sent to your phone. It follows the digest setting above, not quiet hours, and never carries a key.">
        <div className="key-status">
          {state === null ? null : telegram ? (
            <span className="key-saved">
              <Glyph name="check" size={12} />
              Set up
            </span>
          ) : (
            <span className="muted">Not set up</span>
          )}
          <Button size="sm" onClick={() => goTo('keys')}>
            {telegram ? 'Change in Keys' : 'Set up in Keys'}
          </Button>
        </div>
      </Row>
      <Row label="Test" align="start" help="Sends one notification to this Mac, so you can see how they arrive.">
        <div className="stack">
          <Button
            size="sm"
            busy={test.busy}
            busyLabel="Sending…"
            onClick={() => {
              setSent(false);
              void test.run().then((ok) => setSent(ok));
            }}
          >
            Send a test notification
          </Button>
          {sent ? <p className="field-status field-status-ok">Sent.</p> : null}
          {test.error ? (
            <p className="field-status field-status-error" role="alert">
              {test.error}
            </p>
          ) : null}
        </div>
      </Row>
    </Pane>
  );
}
