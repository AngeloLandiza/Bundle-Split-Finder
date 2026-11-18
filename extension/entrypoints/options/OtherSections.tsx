import { useEffect, useState } from 'react';
import { KNOWN_BRANDS, type ExtensionSettings, type SettingsField } from '@core/settings';
import type { FeeSettings } from '@core/money';
import { Confirm, NumberField, Section } from './fields';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { getShowChip, setShowChip } from '../../lib/prefs';

type Problems = Partial<Record<SettingsField, string>>;
interface Props {
  draft: ExtensionSettings;
  problems: Problems;
  onChange(patch: Partial<ExtensionSettings>, commit?: boolean): void;
  onCommit(): void;
}

export function WhatToScanSection({ draft, problems, onChange, onCommit }: Props) {
  const toggle = (brand: string, on: boolean) => {
    const next = KNOWN_BRANDS.filter((b) => (b === brand ? on : draft.brands.includes(b)));
    onChange({ brands: [...next] }, true);
  };
  return (
    <Section title="What to scan" help="Brands your seller account can list. Each brand costs one search per listing page.">
      <fieldset className="group group--across">
        <legend>Brands</legend>
        {KNOWN_BRANDS.map((brand) => (
          <label className="choice" key={brand}>
            <input
              type="checkbox"
              checked={draft.brands.includes(brand)}
              aria-describedby={problems.brands ? 'error-brands' : undefined}
              onChange={(e) => toggle(brand, e.target.checked)}
            />
            {brand}
          </label>
        ))}
        {problems.brands ? (
          <p id="error-brands" className="field-error group-error">
            {problems.brands}
          </p>
        ) : null}
      </fieldset>
      <div>
        <NumberField
          id="pages"
          label="Listing pages per brand"
          width={120}
          min={1}
          max={5}
          value={draft.pagesPerBrand}
          invalid={Boolean(problems.pagesPerBrand)}
          error={problems.pagesPerBrand}
          onCommit={onCommit}
          onChange={(v) => onChange({ pagesPerBrand: v })}
          after={<span className="hint">24 bundles a page, biggest discounts first</span>}
        />
      </div>
    </Section>
  );
}

type FeeKey = 'referralRate' | 'fulfillmentFee' | 'salesTaxRate' | 'inboundCost';
const FEE_FIELDS: { key: FeeKey; id: string; label: string; scale?: number; max?: number; decimals?: number }[] = [
  { key: 'referralRate', id: 'ref', label: 'Referral fee, %', scale: 100, max: 100 },
  { key: 'fulfillmentFee', id: 'ful', label: 'Fulfillment per unit, $', decimals: 2 },
  { key: 'salesTaxRate', id: 'tax', label: 'Sales tax on purchases, %', scale: 100 },
  { key: 'inboundCost', id: 'inb', label: 'Inbound cost per bundle, $', decimals: 2 },
];

const badFee = (key: FeeKey, v: number): boolean =>
  !Number.isFinite(v) || v < 0 || (key === 'referralRate' && v > 1);

export function FeesSection({ draft, problems, onChange, onCommit }: Props) {
  const setFee = (patch: Partial<FeeSettings>) => onChange({ fees: { ...draft.fees, ...patch } });
  return (
    <Section
      title="Fees"
      help="Used for every profit estimate. Amazon charges 15% on most tools and 12% on base equipment power tools."
    >
      <div className="grid">
        {FEE_FIELDS.map((f) => (
          <NumberField
            key={f.id}
            id={f.id}
            label={f.label}
            scale={f.scale}
            decimals={f.decimals}
            step="any"
            min={0}
            max={f.max}
            value={draft.fees[f.key]}
            invalid={Boolean(problems.fees) && badFee(f.key, draft.fees[f.key])}
            describedBy={problems.fees ? 'error-fees' : undefined}
            onCommit={onCommit}
            onChange={(v) => setFee({ [f.key]: v })}
          />
        ))}
      </div>
      {problems.fees ? (
        <p id="error-fees" className="field-error">
          {problems.fees}
        </p>
      ) : null}
    </Section>
  );
}

/** Where the chip setting is read and saved: storage.local with the other prefs (prefs.ts). The worker tells open Home Depot tabs. */
export interface ChipPrefs {
  get(): Promise<boolean>;
  set(on: boolean): Promise<void>;
}
const realChipPrefs: ChipPrefs = { get: getShowChip, set: setShowChip };

/** "Show the chip on Home Depot pages". Saves on change, like every other setting. */
function ChipToggle({ prefs }: { prefs: ChipPrefs }) {
  // Checked until the stored answer arrives: the default is on.
  const [on, setOn] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    prefs.get().then(
      (v) => live && setOn(v),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [prefs]);

  async function change(next: boolean) {
    setOn(next);
    setFailed(false);
    try {
      await prefs.set(next);
    } catch {
      setOn(!next);
      setFailed(true);
    }
  }

  return (
    <div>
      <label className="choice">
        <input type="checkbox" checked={on} onChange={(e) => void change(e.target.checked)} />
        Show the chip on Home Depot pages
      </label>
      {failed ? (
        <p className="field-error" role="alert">
          Not saved. Try again.
        </p>
      ) : null}
    </div>
  );
}

export function AlertsSection({ draft, problems, onChange, onCommit, chip = realChipPrefs }: Props & { chip?: ChipPrefs }) {
  const a = draft.alerts;
  const bad = (v: number) => Boolean(problems.alerts) && (!Number.isFinite(v) || v < 0);
  return (
    <Section
      title="Alerts"
      help="A desktop notification when a scan finds a bundle that clears both estimated numbers. The chip shows a bundle's estimate under its price on Home Depot."
    >
      <label className="choice">
        <input type="checkbox" checked={a.enabled} onChange={(e) => onChange({ alerts: { ...a, enabled: e.target.checked } }, true)} />
        Notify me about new deals
      </label>
      <div className="row row--wide">
        <NumberField
          id="minp"
          label="Estimated profit at least, $"
          width={140}
          step="any"
          min={0}
          value={a.minProfit}
          invalid={bad(a.minProfit)}
          describedBy={problems.alerts ? 'error-alerts' : undefined}
          onCommit={onCommit}
          onChange={(v) => onChange({ alerts: { ...a, minProfit: v } })}
        />
        <NumberField
          id="minr"
          label="Estimated ROI at least, %"
          width={140}
          step="any"
          min={0}
          value={a.minRoiPercent}
          invalid={bad(a.minRoiPercent)}
          describedBy={problems.alerts ? 'error-alerts' : undefined}
          onCommit={onCommit}
          onChange={(v) => onChange({ alerts: { ...a, minRoiPercent: v } })}
        />
      </div>
      {problems.alerts ? (
        <p id="error-alerts" className="field-error">
          {problems.alerts}
        </p>
      ) : null}
      <ChipToggle prefs={chip} />
    </Section>
  );
}

export function DataSection({ api }: { api: WorkerApi }) {
  const [note, setNote] = useState<string | null>(null);

  async function exportFile(type: 'exportDeals' | 'exportMatches', filename: string, mime: string) {
    setNote(null);
    try {
      const reply = await api.send<string>({ type });
      if (reply.ok) api.download(filename, reply.data, mime);
      else setNote(reply.error);
    } catch {
      setNote(UNREACHABLE);
    }
  }

  async function clear() {
    setNote(null);
    try {
      const reply = await api.send<unknown>({ type: 'clearSavedSearches' });
      setNote(reply.ok ? 'Saved searches cleared. Matches and answers were kept.' : reply.error);
    } catch {
      setNote(UNREACHABLE);
    }
  }

  return (
    <Section title="Your data" help="Everything stays in this browser. Export it to keep a copy or move to another computer.">
      <div className="row">
        <button type="button" className="btn" onClick={() => exportFile('exportDeals', 'split-finder-deals.csv', 'text/csv')}>
          Export deals as CSV
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => exportFile('exportMatches', 'split-finder-matches.json', 'application/json')}
        >
          Export matches and answers
        </button>
        <Confirm
          label="Clear saved searches"
          question="Delete the saved search results? The next scan will spend searches again."
          yes="Yes, clear"
          danger
          onYes={clear}
        />
      </div>
      <p className="note" role="status" data-testid="data-status">
        {note}
      </p>
    </Section>
  );
}
