import { useState } from 'react';
import { api, useAction } from '../api/hooks';
import type { BogoView } from '../api/types';
import { pickedTools, typedTool, type FreeToolForm } from '../lib/bogo';
import { Button } from './Button';
import { TextField } from './Fields';
import { Sheet, SheetActions } from './Sheet';
import './BogoSheet.css';

export interface BogoTarget {
  dealId: string;
  model: string;
  /** The promotion as it stands; null while the deal is not marked as a BOGO. */
  bogo: BogoView | null;
}

/**
 * Choose the free tool of a BOGO deal (docs/decisions.md, "BOGO is the owner's entry until a recording shows how Home
 * Depot marks it"). With the promotion's eligible list he picks from it; without one he types the model, and the title
 * and link if he has them. A deal not yet marked can be marked now and the tool chosen later. Nothing is chosen for him.
 */
export function BogoSheet({ target, onClose }: { target: BogoTarget; onClose: () => void }) {
  const { dealId, model, bogo } = target;
  const eligible = bogo?.eligible && bogo.eligible.length > 0 ? bogo.eligible : null;
  const freeCount = bogo?.freeCount ?? 1;
  const [picked, setPicked] = useState<string[]>(bogo?.chosen.map((c) => c.model) ?? []);
  const [form, setForm] = useState<FreeToolForm>({ model: '', title: '', link: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useAction(api.setBogo);

  const run = async (body: Parameters<typeof api.setBogo>[1]) => {
    if (await save.run(dealId, body)) onClose();
  };
  const submit = async () => {
    const r = eligible ? pickedTools(eligible, picked, freeCount) : typedTool(form);
    if (!r.ok) {
      setProblem(r.problem);
      return;
    }
    await run(r.body);
  };
  const toggle = (m: string) => {
    setProblem(null);
    setPicked((cur) => (freeCount === 1 ? [m] : cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
  };
  const set = (patch: Partial<FreeToolForm>) => {
    setProblem(null);
    setForm((f) => ({ ...f, ...patch }));
  };
  const error = problem ?? save.error;
  const free = freeCount === 1 ? 'free tool' : 'free tools';

  return (
    <Sheet
      label={bogo ? `BOGO: choose your ${free}` : 'Mark as BOGO'}
      width={520}
      onCancel={onClose}
      footer={
        <SheetActions
          lead={
            bogo === null ? (
              <Button disabled={save.busy} onClick={() => void run({})} title="Mark the deal as a BOGO promotion now and choose the free tool later">
                Mark without a tool
              </Button>
            ) : null
          }
          secondary={<Button onClick={onClose}>Cancel</Button>}
          primary={
            <Button variant="primary" busy={save.busy} busyLabel="Saving…" onClick={() => void submit()}>
              Save {free}
            </Button>
          }
        />
      }
    >
      <h2 className="bg-title">{bogo ? `BOGO: choose your ${free}` : 'Mark as BOGO'}</h2>
      <p className="bg-part">
        <span className="code">{model}</span>
      </p>
      <p className="bg-line">
        {eligible
          ? `Pick the ${free} you will take with this bundle. Its parts are counted in the estimate once they are priced on Amazon.`
          : 'Home Depot’s list of eligible tools is not read yet. Enter the tool you will take: a model number is enough, and the title and link help you check it later.'}
      </p>
      <p className="bg-fine">
        This is for a promotion Home Depot lists no starter + free tool pairs for. When it lists them, the agent finds them by itself each scan and shows them under BOGO choices.
      </p>

      <form
        className="bg-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {eligible ? (
          <fieldset className="bg-choices">
            <legend className="bg-legend">{freeCount === 1 ? 'Eligible tools' : `Eligible tools, up to ${freeCount}`}</legend>
            <div className="bg-box">
              {eligible.map((item) => (
                <label key={item.model} className={`bg-choice${picked.includes(item.model) ? ' bg-choice-on' : ''}`}>
                  <input type={freeCount === 1 ? 'radio' : 'checkbox'} name="bogo-choice" checked={picked.includes(item.model)} onChange={() => toggle(item.model)} />
                  <span className="bg-choice-text">
                    <span className="bg-choice-model code">{item.model}</span>
                    {item.title ? <span className="bg-choice-sub">{item.title}</span> : null}
                  </span>
                  {item.link ? (
                    <a href={item.link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                      Open on Home Depot
                    </a>
                  ) : null}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <div className="bg-fields">
            <TextField label="Model number" mono autoComplete="off" spellCheck={false} placeholder="DCF887B" width="sm" value={form.model} onChange={(e) => set({ model: e.target.value })} autoFocus />
            <TextField label="Title (optional)" autoComplete="off" maxLength={200} placeholder="As Home Depot names it" value={form.title} onChange={(e) => set({ title: e.target.value })} />
            <TextField label="Link to the tool (optional)" type="url" autoComplete="off" placeholder="https://www.homedepot.com/…" value={form.link} onChange={(e) => set({ link: e.target.value })} />
          </div>
        )}
        <button type="submit" hidden />
      </form>

      <p className="bg-fine">Nothing here is picked for you. The free tool is not counted in the estimate until its parts have a price. Profit stays an estimate from your fee settings.</p>
      {error ? (
        <p className="bg-error" role="alert">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}
