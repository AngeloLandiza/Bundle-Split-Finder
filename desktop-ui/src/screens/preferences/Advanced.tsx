import { useApp } from '../../api/hooks';
import { agentWords } from '../../components/StatusLine';
import { Pane, Row } from './form';
import { useAppInfo } from './Data';

export function AdvancedPane() {
  const { state, online } = useApp();
  const info = useAppInfo();
  const port = info?.port ?? (window.location.port ? Number(window.location.port) : 8790);
  const words = state ? agentWords(state.agent) : null;
  return (
    <Pane>
      <Row label="Agent" align="start" help="The agent is the small program that scans, answers and keeps your data. It runs inside Split Finder and listens only on this Mac.">
        <div className="stack">
          <p>
            <strong>{online ? 'Running' : 'Not running'}</strong>
            {words ? <span className="muted"> · {words.state.toLowerCase()}</span> : null}
          </p>
          <p className="muted">
            Address <span className="code selectable">127.0.0.1:{port}</span>
          </p>
        </div>
      </Row>
      <Row label="Version">
        <p>{info ? <span className="fig">{info.version}</span> : <span className="muted">Shown inside the Split Finder app.</span>}</p>
      </Row>
      <Row label="Data folder" align="start">
        {info?.dataDir ? <p className="code path selectable">{info.dataDir}</p> : <p className="muted">Shown inside the Split Finder app.</p>}
      </Row>
      <Row label="Logs" align="start">
        <p className="muted">The agent keeps no log file. What goes wrong is listed in Activity, in one sentence, with a Retry where one helps.</p>
      </Row>
    </Pane>
  );
}
