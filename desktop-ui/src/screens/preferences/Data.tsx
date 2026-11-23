import { useEffect, useState } from 'react';
import { api, useAction } from '../../api/hooks';
import { Button } from '../../components/Button';
import { inShell, invokeShell, type AppInfo } from '../../lib/shell';
import { words } from '../../lib/platform';
import { Pane, Row } from './form';

/** What the app keeps on this Mac, from the shell (the app's version, its data folder). Null outside the app. */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    if (!inShell()) return;
    invokeShell<AppInfo>('app_info')
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);
  return info;
}

export function DataPane() {
  const info = useAppInfo();
  const csv = useAction(() => api.downloadDealsCsv({ sort: 'profit' }));
  const [saved, setSaved] = useState(false);
  const reveal = useAction(() => invokeShell('reveal_data_folder'));

  return (
    <Pane>
      <Row label="Deals" align="start" help="Every deal the last scan found, best estimated profit first. Profit and ROI in the file are estimates.">
        <div className="stack">
          <Button
            busy={csv.busy}
            busyLabel="Exporting…"
            glyph="download"
            onClick={() => {
              setSaved(false);
              void csv.run().then((ok) => setSaved(ok));
            }}
          >
            Export deals as CSV
          </Button>
          {saved ? <p className="field-status field-status-ok">Exported.</p> : null}
          {csv.error ? (
            <p className="field-status field-status-error" role="alert">
              {csv.error}
            </p>
          ) : null}
        </div>
      </Row>
      <Row label="Data folder" align="start" help={`Settings, keys, deals and the scan history live here, on this ${words.computer} only.`}>
        <div className="stack">
          {info?.dataDir ? <p className="code path selectable">{info.dataDir}</p> : <p className="muted">{inShell() ? 'Not known yet.' : 'Shown inside the Split Finder app.'}</p>}
          <Button disabled={!info?.dataDir} busy={reveal.busy} onClick={() => void reveal.run()}>
            {words.revealFolder}
          </Button>
          {reveal.error ? (
            <p className="field-status field-status-error" role="alert">
              {reveal.error}
            </p>
          ) : null}
        </div>
      </Row>
    </Pane>
  );
}
