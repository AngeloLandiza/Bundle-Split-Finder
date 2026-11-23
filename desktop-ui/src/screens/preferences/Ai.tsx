import { useApp } from '../../api/hooks';
import type { AppSettings } from '../../api/types';
import { Select, Switch } from '../../components/Fields';
import { Meter } from '../../components/States';
import { money } from '../../lib/format';
import { RULES, checkBaseUrl } from '../../lib/prefs';
import { CommitField, NumberField, Pane, Row, Rule, usePrefs } from './form';

type Pipeline = 'judge' | 'assist' | 'research';
type Setting = AppSettings['ai']['judge'];

const PIPELINES: { id: Pipeline; label: string; help: string }[] = [
  { id: 'judge', label: 'Listing check', help: 'Reads eBay and Amazon listings to say whether one is the part.' },
  { id: 'assist', label: 'Ask AI', help: 'Drafts an answer to one Review question from the pages.' },
  { id: 'research', label: 'Research', help: 'Reads Home Depot and brand sites to find a kit’s parts.' },
];

export function AiPane() {
  const { settings, update } = usePrefs();
  const { state } = useApp();
  const cap = settings.ai.monthlyCapUsd;
  const spent = state?.budget.aiSpentUsd ?? null;
  return (
    <Pane>
      <Row label="Autopilot" align="start" help="Applies an AI answer without you only when the code checked it against the pages and the model below is marked trusted. Each one is listed in Activity with Undo. Anything unverified waits in Review.">
        <Switch label={settings.autopilot ? 'On' : 'Off'} checked={settings.autopilot} onChange={(autopilot) => update({ autopilot })} />
      </Row>
      <Row label="Monthly AI cap" align="start" help={cap === 0 ? '0 turns the AI off.' : 'At the cap the AI waits until next month and questions stay in Review. 0 turns the AI off.'}>
        <div className="stack">
          <NumberField label="Monthly AI cap" value={cap} rule={RULES.monthlyCapUsd} prefix="$" step="1" onCommit={(monthlyCapUsd) => update({ ai: { monthlyCapUsd } }, { delay: 600 })} />
          {spent !== null ? (
            <div className="spend">
              <p>
                <span className="fig">{money(spent)}</span> spent this month{cap > 0 ? <> of <span className="fig">{money(cap)}</span></> : null}
              </p>
              {cap > 0 ? <Meter value={Math.min(spent, cap)} max={cap} label="AI spend this month against the cap" /> : null}
            </div>
          ) : null}
        </div>
      </Row>
      {PIPELINES.map((p) => (
        <PipelineRows key={p.id} id={p.id} label={p.label} help={p.help} />
      ))}
    </Pane>
  );
}

function PipelineRows({ id, label, help }: { id: Pipeline; label: string; help: string }) {
  const { settings, update } = usePrefs();
  const cur: Setting = settings.ai[id];
  const change = (next: Partial<Setting>, delay = 0) => update({ ai: { [id]: next } }, { delay });
  return (
    <>
      <Rule />
      <Row label={label} help={help}>
        <Select label={<span className="sr-only">{label} provider</span>} value={cur.provider} width="md" onChange={(e) => change({ provider: e.target.value as Setting['provider'] })}>
          <option value="anthropic">Anthropic</option>
          <option value="openai-compatible">OpenAI-compatible</option>
        </Select>
      </Row>
      <Row label="Model">
        <CommitField
          label={`${label} model`}
          value={cur.model}
          check={(t) => (t.trim() ? { ok: true, value: t.trim() } : { ok: false, message: 'Model: enter the name of a model.' })}
          onCommit={(model) => change({ model }, 600)}
        />
      </Row>
      {cur.provider === 'openai-compatible' ? (
        <Row label="Base URL">
          <CommitField
            label={`${label} base URL`}
            value={cur.baseUrl ?? ''}
            placeholder="https://api.deepseek.com"
            check={(t) => (t.trim() === '' ? { ok: true, value: '' } : checkBaseUrl(t))}
            onCommit={(baseUrl) => change({ baseUrl }, 600)}
          />
        </Row>
      ) : null}
      <Row label="Trusted for Autopilot" align="start" help="Trust belongs to one model. Change the provider, model or address and it goes back to the measured list, so a model you have not measured is off until you turn it on.">
        <Switch label={cur.trusted ? 'Trusted' : 'Not trusted'} checked={cur.trusted} onChange={(trusted) => change({ trusted })} />
      </Row>
    </>
  );
}
