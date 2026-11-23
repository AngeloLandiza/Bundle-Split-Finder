import { CLAUDE_JUDGE_MODELS } from '@core/judge/claude';
import { SCHEDULE_PRESETS, type Schedule } from '@core/schedule';
import { MAX_LISTINGS_JUDGED_PER_SCAN } from '@core/scan/ebayPass';
import { DEFAULT_EBAY_SETTINGS } from '@core/settings';
import { useEffect, useState } from 'react';
import { api } from '../api';

function scheduleKey(s: Schedule): string {
  if (s.mode === 'manual') return 'manual';
  if (s.mode === 'interval') return `interval:${s.hours}`;
  return `daily:${s.at}`;
}

function scheduleFromKey(key: string): Schedule {
  if (key === 'manual') return { mode: 'manual' };
  if (key.startsWith('interval:')) return { mode: 'interval', hours: Number(key.slice(9)) };
  if (key.startsWith('daily:')) return { mode: 'daily', at: key.slice(6) };
  return { mode: 'manual' };
}

export function SettingsView({ onDone }: { onDone?: () => void } = {}) {
  const [key, setKey] = useState('');
  const [line, setLine] = useState('');
  const [compact, setCompact] = useState(false);
  const [searches, setSearches] = useState(5);
  const [reserve, setReserve] = useState(100);
  const [keepaScan, setKeepaScan] = useState(0);
  const [keepaReserve, setKeepaReserve] = useState(0);
  const [inbound, setInbound] = useState(0);
  const [fulfillment, setFulfillment] = useState(0);
  const [salesTax, setSalesTax] = useState(0);
  const [brands, setBrands] = useState<string[]>(['DEWALT', 'RYOBI']);
  const [pagesPerBrand, setPagesPerBrand] = useState(1);
  const [scheduleKeyState, setScheduleKeyState] = useState('manual');
  const [keepaKey, setKeepaKey] = useState('');
  const [ebayApp, setEbayApp] = useState('');
  const [ebayCert, setEbayCert] = useState('');
  const [anthropic, setAnthropic] = useState('');
  const [serpCheck, setSerpCheck] = useState<string | null>(null);
  const [checkingSerp, setCheckingSerp] = useState(false);
  const [ebayCheck, setEbayCheck] = useState<string | null>(null);
  const [checkingEbay, setCheckingEbay] = useState(false);
  const [judgeModel, setJudgeModel] = useState(DEFAULT_EBAY_SETTINGS.judgeModel);
  const [listingsJudged, setListingsJudged] = useState(DEFAULT_EBAY_SETTINGS.listingsJudgedPerScan);
  const [askAfterScan, setAskAfterScan] = useState(false);

  useEffect(() => {
    void api.settings().then((s) => {
      if (!s.ok) return;
      const hints: string[] = [];
      if (s.serpApiKeySet) hints.push('SerpApi on file');
      if (s.keepaKeySet) hints.push('Keepa on file');
      if (s.ebayKeysSet) hints.push('eBay on file');
      if (s.anthropicKeySet) hints.push('Anthropic on file');
      setLine(hints.length ? `${hints.join(' · ')}. Enter a new key to replace.` : 'Paste keys below. The helper syncs within a minute.');
      setCompact(s.compactHelperPanel === true);
      setSearches(s.settings?.searchesPerScan ?? 5);
      setReserve(s.settings?.reserve ?? 100);
      setKeepaScan(s.settings?.keepaTokensPerScan ?? 0);
      setKeepaReserve(s.settings?.keepaReserve ?? 0);
      setInbound(s.settings?.fees?.inboundCost ?? 0);
      setFulfillment(s.settings?.fees?.fulfillmentFee ?? 0);
      setSalesTax((s.settings?.fees?.salesTaxRate ?? 0) * 100);
      setBrands(s.settings?.brands ?? ['DEWALT', 'RYOBI']);
      setPagesPerBrand(s.settings?.pagesPerBrand ?? 1);
      setScheduleKeyState(scheduleKey(s.settings?.schedule ?? { mode: 'manual' }));
      if (s.ebaySettings) {
        setJudgeModel(s.ebaySettings.judgeModel);
        setListingsJudged(s.ebaySettings.listingsJudgedPerScan);
      }
      setAskAfterScan(s.askAfterScan === true);
    });
  }, []);

  const toggleBrand = (name: string) => {
    setBrands((cur) => (cur.includes(name) ? cur.filter((b) => b !== name) : [...cur, name]));
  };

  const save = () => {
    void api
      .saveSettings({
        serpApiKey: key || undefined,
        keepaApiKey: keepaKey || undefined,
        ebayAppId: ebayApp || undefined,
        ebayCertId: ebayCert || undefined,
        anthropicKey: anthropic || undefined,
        ebaySettings: { judgeModel, listingsJudgedPerScan: listingsJudged },
        askAfterScan,
        appPrimaryUi: true,
        compactHelperPanel: compact,
        settings: {
          schedule: scheduleFromKey(scheduleKeyState),
          searchesPerScan: searches,
          reserve,
          agentBridgeAfterScan: true,
          keepaTokensPerScan: keepaScan,
          keepaReserve,
          brands: brands.length ? brands : ['DEWALT'],
          pagesPerBrand,
          fees: {
            inboundCost: inbound,
            fulfillmentFee: fulfillment,
            salesTaxRate: salesTax / 100,
          },
        },
      })
      .then((r) => {
        setLine(r.ok ? 'Saved. The helper syncs shortly.' : 'Could not save.');
        if (r.ok) {
          setKey('');
          setKeepaKey('');
          setEbayApp('');
          setEbayCert('');
          setAnthropic('');
        }
      });
  };

  return (
    <section className="band">
      {onDone ? (
        <button type="button" className="btn btn-secondary" style={{ marginBottom: 12 }} onClick={onDone}>
          Back
        </button>
      ) : null}
      <p className="label">Settings</p>
      <label className="figure" htmlFor="key">
        SerpApi key
      </label>
      <input
        id="key"
        type="password"
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={checkingSerp || !key.trim()}
          onClick={() => {
            setCheckingSerp(true);
            setSerpCheck(null);
            void api
              .checkSerpKey(key.trim())
              .then((r) => {
                if (r.ok) {
                  setSerpCheck(
                    `Key works. ${r.account.planName} · ${r.account.totalSearchesLeft} of ${r.account.searchesPerMonth} searches left · ${r.account.rateLimitPerHour} an hour.`,
                  );
                } else setSerpCheck(r.message ?? 'Could not check key.');
              })
              .finally(() => setCheckingSerp(false));
          }}
        >
          {checkingSerp ? 'Checking…' : 'Check key'}
        </button>
      </div>
      {serpCheck ? <p className="copy-muted">{serpCheck}</p> : null}
      <label className="figure" htmlFor="schedule">
        Scan schedule
      </label>
      <select
        id="schedule"
        value={scheduleKeyState}
        onChange={(e) => setScheduleKeyState(e.target.value)}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      >
        {SCHEDULE_PRESETS.map((p) => (
          <option key={scheduleKey(p.schedule)} value={scheduleKey(p.schedule)}>
            {p.label}
          </option>
        ))}
      </select>
      <p className="figure">Schedules run only while Chrome is open with the helper loaded.</p>
      <label className="figure" htmlFor="searches">
        Searches per scan
      </label>
      <input
        id="searches"
        type="number"
        min={1}
        max={250}
        value={searches}
        onChange={(e) => setSearches(Number(e.target.value))}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <label className="figure" htmlFor="reserve">
        Reserve searches
      </label>
      <input
        id="reserve"
        type="number"
        min={0}
        max={250}
        value={reserve}
        onChange={(e) => setReserve(Number(e.target.value))}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <p className="label" style={{ marginTop: 16 }}>
        Fee estimates
      </p>
      <p className="figure">Profit in the app uses these numbers, not your real Amazon fees.</p>
      <label className="figure" htmlFor="inbound">
        Inbound cost per bundle ($)
      </label>
      <input
        id="inbound"
        type="number"
        min={0}
        step={0.01}
        value={inbound}
        onChange={(e) => setInbound(Number(e.target.value))}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <label className="figure" htmlFor="fulfillment">
        Fulfillment fee per unit ($)
      </label>
      <input
        id="fulfillment"
        type="number"
        min={0}
        step={0.01}
        value={fulfillment}
        onChange={(e) => setFulfillment(Number(e.target.value))}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <label className="figure" htmlFor="tax">
        Sales tax on purchase (%)
      </label>
      <input
        id="tax"
        type="number"
        min={0}
        max={100}
        step={0.1}
        value={salesTax}
        onChange={(e) => setSalesTax(Number(e.target.value))}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <p className="label" style={{ marginTop: 16 }}>
        What to scan
      </p>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        {(['DEWALT', 'RYOBI'] as const).map((b) => (
          <label key={b} className="figure" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={brands.includes(b)} onChange={() => toggleBrand(b)} />
            {b}
          </label>
        ))}
      </div>
      <label className="figure" htmlFor="pages" style={{ marginTop: 8 }}>
        Home Depot pages per brand
      </label>
      <input
        id="pages"
        type="number"
        min={1}
        max={5}
        value={pagesPerBrand}
        onChange={(e) => setPagesPerBrand(Number(e.target.value))}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <p className="label" style={{ marginTop: 16 }}>
        Keepa
      </p>
      <label className="figure" htmlFor="keepa-key">
        Keepa API key
      </label>
      <input
        id="keepa-key"
        type="password"
        autoComplete="off"
        value={keepaKey}
        onChange={(e) => setKeepaKey(e.target.value)}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <label className="figure" htmlFor="keepa-scan">
        Keepa tokens per scan (0 = off)
      </label>
      <input
        id="keepa-scan"
        type="number"
        min={0}
        value={keepaScan}
        onChange={(e) => setKeepaScan(Number(e.target.value))}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <label className="figure" htmlFor="keepa-reserve">
        Keepa reserve tokens
      </label>
      <input
        id="keepa-reserve"
        type="number"
        min={0}
        value={keepaReserve}
        onChange={(e) => setKeepaReserve(Number(e.target.value))}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <p className="label" style={{ marginTop: 16 }}>
        eBay reference (optional)
      </p>
      <p className="copy-muted">eBay sold prices are references only; they are not counted in profit until you confirm a listing.</p>
      <label className="figure" htmlFor="ebay-app">
        eBay App ID (Client ID)
      </label>
      <input
        id="ebay-app"
        type="password"
        autoComplete="off"
        value={ebayApp}
        onChange={(e) => setEbayApp(e.target.value)}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <label className="figure" htmlFor="ebay-cert">
        eBay Cert ID (Client Secret)
      </label>
      <input
        id="ebay-cert"
        type="password"
        autoComplete="off"
        value={ebayCert}
        onChange={(e) => setEbayCert(e.target.value)}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <button
        type="button"
        className="btn btn-secondary"
        disabled={checkingEbay || !ebayApp.trim() || !ebayCert.trim()}
        style={{ marginBottom: 8 }}
        onClick={() => {
          setCheckingEbay(true);
          setEbayCheck(null);
          void api
            .checkEbayKeys(ebayApp.trim(), ebayCert.trim())
            .then((r) => setEbayCheck(r.ok ? 'eBay accepted these keys.' : (r.message ?? 'Could not check keys.')))
            .finally(() => setCheckingEbay(false));
        }}
      >
        {checkingEbay ? 'Checking…' : 'Check eBay keys'}
      </button>
      {ebayCheck ? <p className="copy-muted">{ebayCheck}</p> : null}
      <label className="figure" htmlFor="anthropic">
        Anthropic key (listing check and Ask AI)
      </label>
      <input
        id="anthropic"
        type="password"
        autoComplete="off"
        value={anthropic}
        onChange={(e) => setAnthropic(e.target.value)}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <label className="figure" htmlFor="judge-model">
        Model for eBay listing check
      </label>
      <select
        id="judge-model"
        value={judgeModel}
        onChange={(e) => setJudgeModel(e.target.value)}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      >
        {CLAUDE_JUDGE_MODELS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <label className="figure" htmlFor="judged-cap">
        Listings judged per scan
      </label>
      <input
        id="judged-cap"
        type="number"
        min={1}
        max={MAX_LISTINGS_JUDGED_PER_SCAN}
        value={listingsJudged}
        onChange={(e) => setListingsJudged(Number(e.target.value))}
        style={{ width: '100%', margin: '8px 0', padding: 8, border: '1px solid var(--line-strong)', borderRadius: 4 }}
      />
      <label className="figure" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
        <input type="checkbox" checked={askAfterScan} onChange={(e) => setAskAfterScan(e.target.checked)} />
        Ask AI after each scan
      </label>
      <p className="copy-muted" style={{ marginTop: 4 }}>
        When a scan finishes, the helper asks AI about open Review questions in the background. Nothing is answered until you approve in Review.
      </p>
      <label className="figure" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
        Keep helper side panel on toolbar click (power users)
      </label>
      <button type="button" className="btn" style={{ marginTop: 12 }} onClick={save}>
        Save settings
      </button>
      <p className="figure" style={{ marginTop: 10 }}>
        {line}
      </p>
    </section>
  );
}