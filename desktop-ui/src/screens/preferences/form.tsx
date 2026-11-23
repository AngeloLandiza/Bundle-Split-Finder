// The Preferences form: the macOS preference layout, a right-aligned label at the start of a row and its
// control after it, hairlines between groups, a quiet help line under a control. Settings save as they are
// changed (PrefsContext), and a field that fails its check says so under itself and saves nothing.

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AppSettings, SettingsPatch } from '../../api/types';
import { TextField } from '../../components/Fields';
import { checkNumber, type NumberRule } from '../../lib/prefs';
import type { Look } from '../../lib/appearance';
import type { PrefTab } from '../../lib/prefs';

export interface PrefsValue {
  settings: AppSettings;
  /** Applies a patch on screen at once and sends it after `delay` ms, so typing is one save. `then` gets the agent's answer. */
  update: (patch: SettingsPatch, o?: { delay?: number; then?: (saved: AppSettings) => void }) => void;
  look: Look;
  setLook: (look: Look) => void;
  goTo: (tab: PrefTab) => void;
}

export const PrefsContext = createContext<PrefsValue | null>(null);

export function usePrefs(): PrefsValue {
  const v = useContext(PrefsContext);
  if (!v) throw new Error('usePrefs outside PrefsContext');
  return v;
}

/** One pane: its rows. */
export function Pane({ children }: { children: ReactNode }) {
  return <div className="pane">{children}</div>;
}

/** A form row: the label right-aligned at the start, the control and its help after it. */
export function Row({ label, help, children, align = 'center' }: { label?: ReactNode; help?: ReactNode; children?: ReactNode; align?: 'center' | 'start' }) {
  const id = useId();
  return (
    <div className={`frow${align === 'start' ? ' frow-start' : ''}`} role={label ? 'group' : undefined} aria-labelledby={label ? id : undefined}>
      <div className="frow-label" id={id}>
        {label}
      </div>
      <div className="frow-control">
        {children}
        {help ? <p className="frow-help">{help}</p> : null}
      </div>
    </div>
  );
}

/** A hairline between groups of rows. */
export function Rule() {
  return <hr className="frule" />;
}

/** A line of explanation spanning the control column. */
export function Note({ children, tone = 'quiet' }: { children: ReactNode; tone?: 'quiet' | 'attention' }) {
  return (
    <div className="frow">
      <div className="frow-label" />
      <p className={`frow-note${tone === 'attention' ? ' frow-note-attention' : ''}`} role={tone === 'attention' ? 'alert' : undefined}>
        {children}
      </p>
    </div>
  );
}

/** A figure with a rule: shows what was typed, saves a value only when it passes, and says why when it does not. */
export function NumberField({
  label,
  value,
  rule,
  onCommit,
  onClear,
  prefix,
  suffix,
  width = 'sm',
  step,
}: {
  label: string;
  value: number;
  rule: NumberRule;
  onCommit: (value: number) => void;
  /** When given, an empty field is allowed and means none: this is called instead of onCommit. */
  onClear?: () => void;
  prefix?: string;
  suffix?: ReactNode;
  width?: 'xs' | 'sm' | 'md';
  step?: string;
}) {
  const [text, setText] = useState(Number.isNaN(value) ? '' : String(value));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  // A value saved elsewhere (or the agent's own answer) shows, unless the owner is in the middle of typing.
  useEffect(() => {
    if (!focused.current) {
      setText(Number.isNaN(value) ? '' : String(value));
      setError(null);
    }
  }, [value]);
  return (
    <TextField
      label={<span className="sr-only">{label}</span>}
      type="number"
      mono
      width={width}
      step={step}
      min={rule.min}
      max={rule.max}
      prefix={prefix}
      suffix={suffix}
      value={text}
      status={error ? { tone: 'error', text: error } : null}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        const r = checkNumber(text, rule);
        if (r.ok) {
          setText(String(r.value));
          setError(null);
        }
      }}
      onChange={(e) => {
        setText(e.target.value);
        if (onClear && e.target.value.trim() === '') {
          setError(null);
          onClear();
          return;
        }
        const r = checkNumber(e.target.value, rule);
        if (r.ok) {
          setError(null);
          onCommit(r.value);
        } else {
          setError(r.message);
        }
      }}
    />
  );
}

/** The two figures of a range, side by side with a word between. */
export function Inline({ children }: { children: ReactNode }) {
  return <div className="frow-inline">{children}</div>;
}

/** A text field with a check: shows what was typed, saves a value only when it passes, and says why when it does not. */
export function CommitField({
  label,
  value,
  check,
  onCommit,
  placeholder,
  mono = true,
  width = 'md',
}: {
  label: string;
  value: string;
  check: (text: string) => { ok: true; value: string } | { ok: false; message: string };
  onCommit: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  width?: 'sm' | 'md' | 'fill';
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(value);
      setError(null);
    }
  }, [value]);
  return (
    <TextField
      label={<span className="sr-only">{label}</span>}
      mono={mono}
      width={width}
      placeholder={placeholder}
      value={text}
      spellCheck={false}
      status={error ? { tone: 'error', text: error } : null}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
      }}
      onChange={(e) => {
        setText(e.target.value);
        const r = check(e.target.value);
        if (r.ok) {
          setError(null);
          onCommit(r.value);
        } else {
          setError(r.message);
        }
      }}
    />
  );
}
