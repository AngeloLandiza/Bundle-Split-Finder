import { forwardRef, useId, useRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Glyph } from './Glyph';
import './Fields.css';

interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  /** A result line under the control: "Saved", "SerpApi did not accept this key." */
  status?: { tone: 'ok' | 'error'; text: string } | null;
  /** Label beside the control instead of above it. */
  inline?: boolean;
}

/** A text, number or password field with a real <label>. `mono` sets keys and model numbers in SF Mono. */
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
            // Numbers and times take tabular figures; SF Mono is only for keys and model numbers.
            className={`field-input${mono ? (rest.type === 'number' || rest.type === 'time' ? ' fig' : ' code') : ''}`}
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
            {status.tone === 'ok' ? <Glyph name="check" size={12} /> : null}
            {status.text}
          </span>
        ) : null}
      </div>
    );
  },
);

/** The search field: a rounded well with the magnifier, and a clear button once something is typed. Esc clears it. */
export function SearchField({ value, onChange, placeholder = 'Search', label, width = 200 }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string; width?: number }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span className="search" style={{ inlineSize: width }}>
      <Glyph name="search" size={14} className="search-glass" />
      <input
        ref={ref}
        type="search"
        className="search-input"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        data-find=""
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          onClick={() => {
            onChange('');
            ref.current?.focus();
          }}
        >
          <Glyph name="clear" size={14} />
        </button>
      ) : null}
    </span>
  );
}

/** A pop-up button: a real <select> drawn as the AppKit pop-up, with the double chevron at its end. */
export function Select({ label, help, inline, children, width = 'md', ...rest }: FieldProps & SelectHTMLAttributes<HTMLSelectElement> & { width?: 'sm' | 'md' | 'fill' | 'auto' }) {
  const id = useId();
  return (
    <div className={`field${inline ? ' field-inline' : ''}`}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <span className={`popup field-${width}`}>
        <select id={id} className="popup-select" {...rest}>
          {children}
        </select>
        <span className="popup-arrows" aria-hidden="true">
          <Glyph name="chevrons" size={12} />
        </span>
      </span>
      {help ? <span className="field-help">{help}</span> : null}
    </div>
  );
}

/** An on/off setting that applies at once: role=switch on a real button, drawn as NSSwitch. */
export function Switch({ label, help, checked, onChange, disabled }: { label: ReactNode; help?: ReactNode; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="switch-row">
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
  size = 'md',
}: {
  legend: string;
  value: V;
  options: { value: V; label: ReactNode; count?: number; title?: string }[];
  onChange: (v: V) => void;
  hideLegend?: boolean;
  size?: 'sm' | 'md';
}) {
  const name = useId();
  return (
    <fieldset className={`seg seg-${size}`}>
      <legend className={hideLegend ? 'sr-only' : 'field-label'}>{legend}</legend>
      <div className="seg-track">
        {options.map((o) => (
          <label key={o.value} className={`seg-option${o.value === value ? ' seg-on' : ''}`} title={o.title}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
            {o.count !== undefined ? <span className="seg-count fig">{o.count}</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A radio group: accent radios, one per line. */
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
