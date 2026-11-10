import { useEffect, useState, type ReactNode } from 'react';

/** One settings section: heading and help on the left, controls on the right. Stacks when narrow. */
export function Section({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-intro">
        <h2>{title}</h2>
        <p>{help}</p>
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

const parse = (text: string): number => (text.trim() === '' ? Number.NaN : Number(text));
const sameNumber = (a: number, b: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b));
const show = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : '');

interface NumberFieldProps {
  id: string;
  label: string;
  /** NaN means the field is empty. An empty field is invalid, never 0. */
  value: number;
  onChange(value: number): void;
  invalid?: boolean;
  /** Id of the element that holds this field's message. */
  describedBy?: string;
  /** Message shown directly under the field. Omit when a shared message is shown elsewhere. */
  error?: string;
  width?: number;
  step?: string;
  min?: number;
  max?: number;
  /** The control is used only inline, as in "Every [24] hours". */
  inline?: boolean;
  ariaLabel?: string;
  /** Multiply for display: a stored rate of 0.15 is shown as 15. */
  scale?: number;
}

/** A number box that can be empty while the owner types. */
export function NumberField(p: NumberFieldProps) {
  const scale = p.scale ?? 1;
  const toShown = (n: number) => show(n * scale);
  const [text, setText] = useState(toShown(p.value));

  // Follow outside changes (for example a new state from the worker), but never overwrite what is being typed.
  useEffect(() => {
    setText((current) => (sameNumber(parse(current) / scale, p.value) ? current : toShown(p.value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.value, scale]);

  const errorId = p.error ? `${p.id}-error` : undefined;
  const input = (
    <input
      id={p.id}
      type="number"
      inputMode="decimal"
      className={`input figure${p.inline ? ' input--small' : ''}`}
      style={p.width ? { width: p.width } : undefined}
      value={text}
      step={p.step}
      min={p.min}
      max={p.max}
      aria-label={p.ariaLabel}
      aria-invalid={p.invalid ? true : undefined}
      aria-describedby={errorId ?? p.describedBy}
      onChange={(e) => {
        setText(e.target.value);
        p.onChange(parse(e.target.value) / scale);
      }}
    />
  );
  if (p.inline) return input;
  return (
    <div className="field">
      <label htmlFor={p.id}>{p.label}</label>
      {input}
      {p.error ? (
        <p id={errorId} className="field-error">
          {p.error}
        </p>
      ) : null}
    </div>
  );
}

/** Two-step button: the first click asks, the second one acts. Real buttons, no dialog needed. */
export function Confirm({
  label,
  question,
  yes,
  danger,
  onYes,
}: {
  label: string;
  question: string;
  yes: string;
  danger?: boolean;
  onYes(): void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={`btn${danger ? ' btn--danger' : ''}`} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <div role="group" aria-label={label} className="confirm">
      <span>{question}</span>
      <button
        type="button"
        className="btn btn--danger"
        onClick={() => {
          setAsking(false);
          onYes();
        }}
      >
        {yes}
      </button>
      <button type="button" className="btn" autoFocus onClick={() => setAsking(false)}>
        Cancel
      </button>
    </div>
  );
}
