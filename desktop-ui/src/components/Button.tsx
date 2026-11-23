import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import './Button.css';

/** "5 searches", "about $0.10": only the figures in the figure face, the words in the word face (design.md). */
export function Figurized({ text }: { text: string }) {
  return (
    <>
      {text.split(/([$\u2212+]?\d[\d,.]*%?)/).map((piece, i) =>
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

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** What the press spends, shown on the control after a middot in the figure face: "5 searches", "about $0.10". */
  cost?: ReactNode;
  /** Shown instead of the label while the action runs; the button stays the same width. */
  busyLabel?: string;
  busy?: boolean;
}

/** Buttons are verbs. Primary is ink, never a brand colour; a paid action shows its price on the control. */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = 'secondary', size = 'md', cost, busy = false, busyLabel, children, className, type = 'button', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ''}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      <span>{busy && busyLabel ? busyLabel : children}</span>
      {cost !== undefined && cost !== null && !busy ? (
        <>
          <span aria-hidden="true" className="btn-dot">
            ·
          </span>
          <span className="btn-cost">{typeof cost === 'string' ? <Figurized text={cost} /> : cost}</span>
        </>
      ) : null}
    </button>
  );
});

/** A link styled as a button, for downloads and pages that open elsewhere. */
export function ButtonLink({ href, children, variant = 'secondary', size = 'md', download, external }: { href: string; children: ReactNode; variant?: ButtonVariant; size?: 'md' | 'sm'; download?: string | boolean; external?: boolean }) {
  return (
    <a
      className={`btn btn-${variant} btn-${size} btn-link`}
      href={href}
      download={download === true ? '' : download || undefined}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}
