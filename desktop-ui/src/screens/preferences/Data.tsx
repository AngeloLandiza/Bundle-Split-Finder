import { useEffect, useState } from 'react';
import { api, useAction } from '../../api/hooks';
import { Button } from '../../components/Button';
import { Sheet, SheetActions } from '../../components/Sheet';
import { inShell, invokeShell, type AppInfo } from '../../lib/shell';
import { words } from '../../lib/platform';
import { RESET_BUTTON, RESET_DELETES, RESET_KEEPS, backupLine } from '../../lib/resetScanData';
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
  const audit = useAction(() => api.downloadAudit());
  const [auditSaved, setAuditSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [backup, setBackup] = useState<string | null>(null);
  const reset = useAction(async () => {
    const r = await api.resetScanData();
    setBackup(r.backup);
    setConfirming(false);
  });
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
      <Row label="Audit file" align="start" help="One file for a developer: what was scanned, matched and asked, and what went wrong. No keys are included.">
        <div className="stack">
          <Button
            busy={audit.busy}
            busyLabel="Exporting…"
            glyph="download"
            onClick={() => {
              setAuditSaved(false);
              void audit.run().then((ok) => setAuditSaved(ok));
            }}
          >
            Export audit file
          </Button>
          {auditSaved ? <p className="field-status field-status-ok">Exported.</p> : null}
          {audit.error ? (
            <p className="field-status field-status-error" role="alert">
              {audit.error}
            </p>
          ) : null}
        </div>
      </Row>
      <Row label="Scan data" align="start" help="Starts the deals, Review and scan history over. Your keys, settings and Chrome pairing stay.">
        <div className="stack">
          <Button
            onClick={() => {
              reset.clear();
              setBackup(null);
              setConfirming(true);
            }}
          >
            Reset scan data…
          </Button>
          {backup ? (
            <p className="field-status field-status-ok">
              Scan data was reset. The backup is in <span className="code path selectable">{backup}</span>.
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
      {confirming ? (
        <Sheet
          label="Reset scan data"
          width={520}
          onCancel={() => setConfirming(false)}
          footer={
            <SheetActions
              secondary={
                <Button onClick={() => setConfirming(false)} data-autofocus="">
                  Cancel
                </Button>
              }
              primary={
                <Button variant="danger" busy={reset.busy} busyLabel="Resetting…" onClick={() => void reset.run()}>
                  {RESET_BUTTON}
                </Button>
              }
            />
          }
        >
          <h2>Reset scan data?</h2>
          <p>This deletes:</p>
          <ul>
            {RESET_DELETES.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p>This stays:</p>
          <ul>
            {RESET_KEEPS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p>{backupLine(info?.dataDir)}</p>
          {reset.error ? (
            <p className="field-status field-status-error" role="alert">
              {reset.error}
            </p>
          ) : null}
        </Sheet>
      ) : null}
    </Pane>
  );
}
