import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import './Fields.css';

interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  /** A result line under the control: "Saved", "SerpApi did not accept this key." */
  status?: { tone: 'ok' | 'error'; text: string } | null;
  /** Label beside the control instead of above it. */
  inline?: boolean;
}

/** A text, number or password field with a real <label>. Figures and keys are set in the figure face. */
export const TextField = forwardRef<HTMLInputElement, FieldProps & InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; width?: 'xs' | 'sm' | 'md' | 'fill'; suffix?: ReactNode; prefix?: ReactNode }>(
  function TextField({ label, help, status, inline, mono, width = 'fill', suffix, prefix, className, ...rest }, ref) {
    const id = useId();
    const helpId = help ? `${id}-help` : undefined;
    const statusId = status ? `${id}-status` : undefined;
    return (
      <div className={`field${inline ? ' field-inline' : ''}${className ? ` ${className}` : ''}`}>
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        <span className={`field-box field-${width}`}>
          {prefix ? <span className="field-affix fig">{prefix}</span> : null}
          <input
            ref={ref}
            id={id}
            className={`field-input${mono ? ' fig' : ''}`}
            aria-describedby={[helpId, statusId].filter(Boolean).join(' ') || undefined}
            aria-invalid={status?.tone === 'error' || undefined}
            {...rest}
          />
          {suffix ? <span className="field-affix">{suffix}</span> : null}
        </span>
        {help ? (
          <span className="field-help" id={helpId}>
            {help}
          </span>
        ) : null}
        {status ? (
          <span className={`field-status field-status-${status.tone}`} id={statusId} role={status.tone === 'error' ? 'alert' : 'status'}>
            {status.text}
          </span>
        ) : null}
      </div>
    );
  },
);

export function Select({ label, help, inline, children, width = 'md', ...rest }: FieldProps & SelectHTMLAttributes<HTMLSelectElement> & { width?: 'sm' | 'md' | 'fill' }) {
  const id = useId();
  return (
    <div className={`field${inline ? ' field-inline' : ''}`}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <span className={`select-box field-${width}`}>
        <select id={id} className="select" {...rest}>
          {children}
        </select>
        <svg className="select-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </span>
      {help ? <span className="field-help">{help}</span> : null}
    </div>
  );
}

/** An on/off setting that applies at once: role=switch on a real button. */
export function Switch({ label, help, checked, onChange, disabled }: { label: ReactNode; help?: ReactNode; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="switch-row">
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        disabled={disabled}
        className="switch"
        onClick={() => onChange(!checked)}
        aria-describedby={help ? `${id}-help` : undefined}
      >
        <span className="switch-knob" />
      </button>
      <span className="switch-text">
        <label htmlFor={id} className="switch-label">
          {label}
        </label>
        {help ? (
          <span className="field-help" id={`${id}-help`}>
            {help}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** A segmented control: one choice of a few, as a radio group with real inputs. */
export function Segmented<V extends string>({
  legend,
  value,
  options,
  onChange,
  hideLegend = true,
}: {
  legend: string;
  value: V;
  options: { value: V; label: ReactNode; count?: number }[];
  onChange: (v: V) => void;
  hideLegend?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="seg">
      <legend className={hideLegend ? 'sr-only' : 'field-label'}>{legend}</legend>
      <div className="seg-track">
        {options.map((o) => (
          <label key={o.value} className={`seg-option${o.value === value ? ' seg-on' : ''}`}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
            {o.count !== undefined ? <span className="seg-count fig">{o.count}</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A radio group in the spec's Settings style: 16px ink radios, 36px rows. */
export function RadioGroup<V extends string>({ legend, value, options, onChange }: { legend: string; value: V; options: { value: V; label: ReactNode }[]; onChange: (v: V) => void }) {
  const name = useId();
  return (
    <fieldset className="radios">
      <legend className="field-label">{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className="radio">
          <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function Checkbox({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="radio">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
