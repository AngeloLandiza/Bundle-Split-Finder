import { useEffect, useState } from 'react';
import { pictureUrl } from '@core/links/pictures';
import { onLinkPrefsChange, readLinkPrefs } from '../lib/linkPrefs';
import './Picture.css';

/**
 * A stored product picture (docs/design.md, Desktop app > Product pictures): the Home Depot or Amazon photo the records
 * hold, or, where none is stored, it failed to load, or pictures are off, a quiet square marked with the brand's initial
 * in the tertiary label colour, so a column of them reads as a placeholder and not a gap. Never a guessed picture, never
 * a broken-image icon. Loads lazily and sends no referrer.
 */
export type PictureSize = 'row' | 'part' | 'head';

/** What the slot shows: the picture, or the neutral square. */
export function pictureShown(src: string | null | undefined, o: { show: boolean; failed: boolean }): string | null {
  if (!o.show || o.failed) return null;
  return pictureUrl(src);
}

/** The placeholder's mark: the first letter of each of the brand's words, at most two ("DEWALT" D, "RYOBI" R); '' for none. */
export function brandMark(brand: string | null | undefined): string {
  if (typeof brand !== 'string') return '';
  return brand
    .trim()
    .split(/\s+/)
    .map((w) => /[A-Za-z0-9]/.exec(w)?.[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** Settings › General › Show product pictures, followed live across the app's windows. */
export function useShowPictures(): boolean {
  const [show, setShow] = useState(() => readLinkPrefs().showPictures);
  useEffect(() => onLinkPrefsChange((p) => setShow(p.showPictures)), []);
  return show;
}

export function Picture({ src, size, label, brand }: { src: string | null | undefined; size: PictureSize; label?: string; brand?: string | null }) {
  const show = useShowPictures();
  const [failed, setFailed] = useState<string | null>(null);
  const url = pictureShown(src, { show, failed: failed !== null && failed === src });
  const mark = url ? '' : brandMark(brand);
  return (
    <span className={`pic pic-${size}${url ? ' pic-has' : ''}`} aria-hidden={label && url ? undefined : true}>
      {url ? (
        <img
          src={url}
          alt={label ?? ''}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(src ?? null)}
        />
      ) : mark ? (
        <span className="pic-mark">{mark}</span>
      ) : null}
    </span>
  );
}
