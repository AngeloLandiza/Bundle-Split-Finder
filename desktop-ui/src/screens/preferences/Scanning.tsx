import { useApp } from '../../api/hooks';
import type { FeeSource, Schedule } from '../../api/types';
import { Button } from '../../components/Button';
import { Checkbox, Select, TextField } from '../../components/Fields';
import { RecommendedScheduleLink } from '../../components/RecommendedScheduleLink';
import { Meter } from '../../components/States';
import { inboundAnswered, salesTaxAnswered } from '@core/estimateNote';
import { count } from '../../lib/format';
import { forecast } from '../../lib/forecast';
import { FBA_AT_ZERO, RULES, isClock } from '../../lib/prefs';
import { useState } from 'react';
import { words } from '../../lib/platform';
import { Inline, NumberField, Note, Pane, Row, Rule, usePrefs } from './form';

const BRANDS = ['DEWALT', 'RYOBI'];
const round = (n: number) => Math.round(n * 100) / 100;

type Mode = Schedule['mode'];
const DEFAULT_SCHEDULE: Record<Mode, Schedule> = {
  manual: { mode: 'manual' },
  interval: { mode: 'interval', hours: 6 },
  daily: { mode: 'daily', at: '06:00' },
};

export function ScanningPane() {
  const { settings, update } = usePrefs();
  const { state } = useApp();
  const cfg = settings.settings;
  const fees = cfg.fees;
  // A store written before the choice existed reads as the flat amount (the agent migrates it once).
  const fromKeepa = fees.fulfillmentSource === 'keepa';
  const budget = state?.budget;
  // Free scan: the bundle lists are read in Chrome unless the owner chose SerpApi; with Keepa, finding bundles spends nothing.
  const source: NonNullable<typeof settings.scan> = settings.scan ?? { listingSource: 'auto', serpWhenChromeClosed: false };
  const free = source.listingSource !== 'serpapi' && Boolean(state?.keys.keepa) && cfg.amazonRefreshViaKeepa;
  const f = forecast(cfg.schedule, cfg.searchesPerScan, budget?.serpMonthly ?? 250, cfg.reserve, { free });
  const setCfg = (part: Partial<typeof cfg>, delay = 0) => update({ settings: part }, { delay });
  // Entering a value, or confirming 0, answers the cost for good: a stored 0 alone cannot tell "none" from "never asked".
  const setFee = (key: keyof typeof fees, value: number) =>
    update({ settings: { fees: { ...fees, [key]: value, ...(key === 'salesTaxRate' ? { salesTaxAnswered: true } : key === 'inboundCost' ? { inboundAnswered: true } : {}) } } }, { delay: 600 });
  const taxAnswered = salesTaxAnswered(fees);
  const inAnswered = inboundAnswered(fees);
  const [timeError, setTimeError] = useState<string | null>(null);

  return (
    <Pane>
      <Row label="Scan for bundles" align="start" help={`The agent scans on its own only while this ${words.computer} is awake and Split Finder is running.`}>
        <div className="stack">
          <Select
            label={<span className="sr-only">Schedule</span>}
            value={cfg.schedule.mode}
            width="md"
            onChange={(e) => {
              setTimeError(null);
              setCfg({ schedule: DEFAULT_SCHEDULE[e.target.value as Mode] });
            }}
          >
            <option value="manual">Off, only when I press Scan now</option>
            <option value="interval">Every few hours</option>
            <option value="daily">Daily at a time</option>
          </Select>
          {cfg.schedule.mode === 'interval' ? (
            <Inline>
              <span>Every</span>
              <NumberField label="Hours between scans" value={cfg.schedule.hours} rule={RULES.scheduleHours} width="xs" onCommit={(hours) => setCfg({ schedule: { mode: 'interval', hours } }, 600)} />
              <span>hours</span>
            </Inline>
          ) : null}
          {cfg.schedule.mode === 'daily' ? (
            <TextField
              label={<span className="sr-only">Time of day</span>}
              type="time"
              mono
              width="sm"
              value={cfg.schedule.at}
              status={timeError ? { tone: 'error', text: timeError } : null}
              onChange={(e) => {
                const at = e.target.value;
                if (!isClock(at)) {
                  setTimeError('Time: use a 24-hour time such as 06:00.');
                  return;
                }
                setTimeError(null);
                setCfg({ schedule: { mode: 'daily', at } }, 600);
              }}
            />
          ) : null}
          <RecommendedScheduleLink />
        </div>
      </Row>
      <Row label="Find bundles" align="start" help="Home Depot’s bundle lists, read in Chrome the way a tab loads them, cost no searches.">
        <div className="stack">
          <Select
            label={<span className="sr-only">Find bundles</span>}
            value={source.listingSource}
            width="md"
            onChange={(e) => update({ scan: { listingSource: e.target.value as typeof source.listingSource } })}
          >
            <option value="auto">In Chrome; SerpApi when Chrome is closed</option>
            <option value="chrome">Only in Chrome</option>
            <option value="serpapi">With SerpApi searches</option>
          </Select>
          {source.listingSource === 'auto' ? (
            <Checkbox
              label="Scheduled scans search SerpApi while Chrome is closed"
              checked={source.serpWhenChromeClosed}
              onChange={(serpWhenChromeClosed) => update({ scan: { serpWhenChromeClosed } })}
            />
          ) : null}
        </div>
      </Row>
      <Row label="Open Chrome" align="start" help="With a schedule set, a few minutes before a scan, and when Home Depot pages have waited an hour, Split Finder starts your own Chrome in the background (your profile, no window brought forward) so the helper can read them. It never closes a Chrome you opened.">
        <div className="stack">
          <Checkbox
            label="Open Chrome for scheduled scans"
            checked={source.openChrome !== false}
            onChange={(openChrome) => update({ scan: { openChrome } })}
          />
          {source.openChrome !== false ? (
            <Checkbox
              label="Close it again after the scan, only if Split Finder opened it"
              checked={source.closeChromeAfter === true}
              onChange={(closeChromeAfter) => update({ scan: { closeChromeAfter } })}
            />
          ) : null}
        </div>
      </Row>
      <Row label="Searches per scan" help="A scan stops at this many SerpApi searches.">
        <NumberField label="Searches per scan" value={cfg.searchesPerScan} rule={RULES.searchesPerScan} onCommit={(searchesPerScan) => setCfg({ searchesPerScan }, 600)} />
      </Row>
      <Row label="Reserve" help="Kept back from scheduled scans for lookups you start yourself.">
        <NumberField label="Reserve" value={cfg.reserve} rule={RULES.reserve} onCommit={(reserve) => setCfg({ reserve }, 600)} />
      </Row>
      <Row label="This month" align="start">
        <div className={`forecast${f.fits ? '' : ' forecast-over'}`} role="status">
          <p className="forecast-head">
            <strong>{f.sentence}</strong>
          </p>
          {f.fits && f.scansPerMonth > 0 ? (
            <p className="muted">
              <span className="fig">{count(f.needed)}</span> of <span className="fig">{count(f.usable)}</span> usable searches a month
            </p>
          ) : null}
          <p className="muted">{f.detail}</p>
          {budget?.serpLeft !== null && budget?.serpLeft !== undefined && budget.serpMonthly ? <Meter value={budget.serpLeft} max={budget.serpMonthly} label="Searches left this month" /> : null}
        </div>
      </Row>
      <Rule />
      <Row label="Brands" align="start" help={source.listingSource === 'serpapi' ? 'Each brand costs searches on every scan. At least one stays on.' : 'Each brand adds its Home Depot list to every scan. At least one stays on.'}>
        <div className="stack">
          {BRANDS.map((b) => (
            <Checkbox
              key={b}
              label={b}
              checked={cfg.brands.includes(b)}
              onChange={(on) => {
                const brands = on ? [...cfg.brands, b] : cfg.brands.filter((x) => x !== b);
                if (brands.length > 0) setCfg({ brands });
              }}
            />
          ))}
        </div>
      </Row>
      <Rule />
      <Row label="Referral fee" help="Amazon's cut of each sale, as a share of the price.">
        <NumberField label="Referral fee" value={round(fees.referralRate * 100)} rule={RULES.referralPercent} suffix="%" step="0.5" onCommit={(v) => setFee('referralRate', round(v / 100))} />
      </Row>
      <Row label="Minimum referral">
        <NumberField label="Minimum referral" value={fees.minReferral} rule={RULES.minReferral} prefix="$" step="0.01" onCommit={(v) => setFee('minReferral', v)} />
      </Row>
      <Row
        label="Fulfillment fee"
        help={fromKeepa ? 'Amazon’s FBA fee for each part’s own listing, as Keepa reads it. A part Keepa has no fee for yet takes the flat amount below.' : undefined}
      >
        <Select
          label={<span className="sr-only">Fulfillment fee</span>}
          value={fromKeepa ? 'keepa' : 'flat'}
          width="md"
          onChange={(e) => update({ settings: { fees: { ...fees, fulfillmentSource: e.target.value as FeeSource } } })}
        >
          <option value="keepa">Amazon’s FBA fee from Keepa (recommended)</option>
          <option value="flat">A flat amount per unit</option>
        </Select>
      </Row>
      <Row label={fromKeepa ? 'Flat amount, when Keepa has none' : 'Fulfillment, per unit'} help={!fromKeepa && fees.fulfillmentFee === 0 ? FBA_AT_ZERO : undefined}>
        <NumberField label="Fulfillment per unit" value={fees.fulfillmentFee} rule={RULES.fulfillmentFee} prefix="$" step="0.01" onCommit={(v) => setFee('fulfillmentFee', v)} />
      </Row>
      <Row label="Sales tax you pay" help={taxAnswered ? undefined : 'Not set yet, so estimates leave it out. Enter it, or confirm that it is 0.'}>
        <Inline>
          <NumberField label="Sales tax" value={round(fees.salesTaxRate * 100)} rule={RULES.salesTaxPercent} suffix="%" step="0.25" onCommit={(v) => setFee('salesTaxRate', round(v / 100))} />
          {taxAnswered ? null : (
            <Button size="sm" onClick={() => setFee('salesTaxRate', 0)}>
              It is 0%
            </Button>
          )}
        </Inline>
      </Row>
      <Row label="Inbound, per bundle" help={inAnswered ? undefined : 'Not set yet, so estimates leave it out. Enter it, or confirm that it is $0.'}>
        <Inline>
          <NumberField label="Inbound cost per bundle" value={fees.inboundCost} rule={RULES.inboundCost} prefix="$" step="0.01" onCommit={(v) => setFee('inboundCost', v)} />
          {inAnswered ? null : (
            <Button size="sm" onClick={() => setFee('inboundCost', 0)}>
              It is $0
            </Button>
          )}
        </Inline>
      </Row>
      <Note>Estimates only: the real fees on your Amazon account may differ.</Note>
      <Rule />
      <Row label="Keepa tokens per scan" help="A scan stops at this many Keepa tokens.">
        <NumberField label="Keepa tokens per scan" value={cfg.keepaTokensPerScan} rule={RULES.keepaTokensPerScan} onCommit={(keepaTokensPerScan) => setCfg({ keepaTokensPerScan }, 600)} />
      </Row>
      <Row label="Keepa reserve" help="Tokens kept back from scheduled scans.">
        <NumberField label="Keepa reserve" value={cfg.keepaReserve} rule={RULES.keepaReserve} onCommit={(keepaReserve) => setCfg({ keepaReserve }, 600)} />
      </Row>
    </Pane>
  );
}
