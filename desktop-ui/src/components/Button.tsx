import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Glyph, type GlyphName } from './Glyph';
import { Spinner } from './States';
import './Button.css';

/** "5 searches", "about $0.10": the figures with tabular numerals, the words as words. */
export function Figurized({ text }: { text: string }) {
  return (
    <>
      {text.split(/([$−+]?\d[\d,.]*%?)/).map((piece, i) =>
        i % 2 === 1 ? (
          <span className="fig" key={i}>
            {piece}
          </span>
        ) : (
          piece
        ),
      )}
    </>
  );
}

/**
 * primary: the default push button, filled with the accent (one per view, Return presses it).
 * secondary: the plain push button. quiet: borderless, for a second action beside a primary.
 * danger: a push button whose words are red, for Revoke and Remove. toolbar: a bordered toolbar item.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'toolbar';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** sm: the small control size (20px); md: regular (22px); lg: large (28px), for the welcome sheet. */
  size?: 'sm' | 'md' | 'lg';
  glyph?: GlyphName;
  /** What the press spends, after a middot: "Scan now · 5 searches", "Ask AI · about $0.10". */
  cost?: ReactNode;
  /** Shown instead of the label while the action runs, after a small spinner. */
  busyLabel?: string;
  busy?: boolean;
}

/** Buttons are verbs. A paid action shows its price on the control, before the click. */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'secondary', size = 'md', glyph, cost, busy = false, busyLabel, children, className, type = 'button', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`btn btn-${variant} btn-${size}${glyph && !children ? ' btn-icon' : ''}${className ? ` ${className}` : ''}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner size={12} /> : glyph ? <Glyph name={glyph} /> : null}
      {children !== undefined && children !== null ? <span className="btn-label">{busy && busyLabel ? busyLabel : children}</span> : null}
      {cost !== undefined && cost !== null && !busy ? (
        <span className="btn-cost">
          <span aria-hidden="true">·</span> {typeof cost === 'string' ? <Figurized text={cost} /> : cost}
        </span>
      ) : null}
    </button>
  );
});

/** A link styled as a push button, for downloads and pages that open elsewhere. */
export function ButtonLink({ href, children, variant = 'secondary', size = 'md', download, external }: { href: string; children: ReactNode; variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg'; download?: string | boolean; external?: boolean }) {
  return (
    <a
      className={`btn btn-${variant} btn-${size} btn-link`}
      href={href}
      download={download === true ? '' : download || undefined}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      <span className="btn-label">{children}</span>
    </a>
  );
}

/** A text button in the accent, for a jump inside the app ("Open Review", "Show all"). */
export function LinkButton({ children, onClick, className }: { children: ReactNode; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`link-btn${className ? ` ${className}` : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}
