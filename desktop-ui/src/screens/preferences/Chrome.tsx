import { useState } from 'react';
import { api, useAction, useApp, useResource } from '../../api/hooks';
import { Button } from '../../components/Button';
import { InstallHelper } from '../../components/SetupParts';
import { spacedCode } from '../../components/PairingNotice';
import { ConfirmInline, LoadError } from '../../components/States';
import { plural, when } from '../../lib/format';
import { Pane, Row, Rule } from './form';

export function ChromePane() {
  const { state, online, refreshState, pairing } = useApp();
  const [res, reload] = useResource(() => api.pairedExtensions(), [], ['state']);
  const [confirm, setConfirm] = useState<string | null>(null);
  const revoke = useAction(api.revokeExtension);
  const h = state?.helper;
  const paired = res.data ?? [];

  return (
    <Pane>
      <Row label="Status" align="start" help="Chrome reads Home Depot pages for the agent while it is open. Pairing lets only your Chrome reach the agent.">
        {h ? (
          <p className="chrome-state">
            <strong>{h.connected ? 'Connected' : h.paired ? 'Paired, Chrome closed' : 'Not connected'}</strong>
            {h.lastSeenAt ? <span className="muted"> · last seen {when(h.lastSeenAt)}</span> : null}
            {h.jobsWaiting ? <span className="muted"> · {plural(h.jobsWaiting, 'page waits', 'pages wait')}</span> : null}
          </p>
        ) : (
          <p className="muted">{online ? 'Checking…' : 'The agent is not running.'}</p>
        )}
      </Row>
      <Row label="Helper" align="start" help="In Chrome, open the Split Finder side panel and press Connect to the app. Chrome then asks here: check that the code matches and allow it.">
        <InstallHelper />
      </Row>
      <Rule />
      <Row label="Waiting to connect" align="start">
        {pairing.requests.length === 0 ? (
          <p className="muted">No requests.</p>
        ) : (
          <ul className="people">
            {pairing.requests.map((r) => (
              <li key={r.requestId} className="person">
                <span className="person-what">
                  <span>
                    Code <span className="fig code">{spacedCode(r.code)}</span>
                  </span>
                  <span className="muted">Allow it only if Chrome shows the same code. Asked {when(r.requestedAt)}.</span>
                </span>
                <span className="person-actions">
                  <Button size="sm" disabled={pairing.busyId === r.requestId} onClick={() => void pairing.decide(r.requestId, false)}>
                    Deny
                  </Button>
                  <Button size="sm" variant="primary" busy={pairing.busyId === r.requestId} busyLabel="Allowing…" onClick={() => void pairing.decide(r.requestId, true)}>
                    Allow
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {pairing.error ? (
          <p className="field-status field-status-error" role="alert">
            {pairing.error}
          </p>
        ) : null}
      </Row>
      <Row label="Paired" align="start">
        {res.status === 'error' && !res.data ? <LoadError error={res.error} onRetry={reload} /> : null}
        {res.status !== 'error' && paired.length === 0 ? <p className="muted">{res.status === 'loading' ? 'Loading…' : 'No Chrome is paired.'}</p> : null}
        {paired.length ? (
          <ul className="people">
            {paired.map((x) => (
              <li key={x.extensionId} className="person">
                <span className="person-what">
                  <span className="code person-id" title={x.extensionId}>
                    {x.extensionId}
                  </span>
                  <span className="muted">
                    Paired {when(x.pairedAt)}
                    {x.lastSeenAt ? `, last seen ${when(x.lastSeenAt)}` : ', not seen yet'}
                  </span>
                </span>
                {confirm === x.extensionId ? (
                  <ConfirmInline
                    question="Revoke this Chrome? Pages wait until you pair it again."
                    confirmLabel="Revoke"
                    busy={revoke.busy}
                    onCancel={() => setConfirm(null)}
                    onConfirm={() =>
                      void revoke.run(x.extensionId).then((ok) => {
                        if (ok) setConfirm(null);
                        reload();
                        refreshState();
                      })
                    }
                  />
                ) : (
                  <Button size="sm" variant="danger" onClick={() => setConfirm(x.extensionId)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {revoke.error ? (
          <p className="field-status field-status-error" role="alert">
            {revoke.error}
          </p>
        ) : null}
      </Row>
    </Pane>
  );
}
