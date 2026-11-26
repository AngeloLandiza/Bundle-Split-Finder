import { useEffect, useState } from 'react';
import { pictureUrl } from '@core/links/pictures';
import { onLinkPrefsChange, readLinkPrefs } from '../lib/linkPrefs';
import './Picture.css';

/**
 * A stored product picture (docs/design.md, Desktop app > Product pictures): the Amazon listing photo the records
 * hold, or a quiet neutral square where none is stored, it failed to load, or pictures are off. Never a guessed
 * picture, never a broken-image icon. Loads lazily and sends no referrer.
 */
export type PictureSize = 'row' | 'part' | 'head';

/** What the slot shows: the picture, or the neutral square. */
export function pictureShown(src: string | null | undefined, o: { show: boolean; failed: boolean }): string | null {
  if (!o.show || o.failed) return null;
  return pictureUrl(src);
}

/** Settings › General › Show product pictures, followed live across the app's windows. */
export function useShowPictures(): boolean {
  const [show, setShow] = useState(() => readLinkPrefs().showPictures);
  useEffect(() => onLinkPrefsChange((p) => setShow(p.showPictures)), []);
  return show;
}

export function Picture({ src, size, label }: { src: string | null | undefined; size: PictureSize; label?: string }) {
  const show = useShowPictures();
  const [failed, setFailed] = useState<string | null>(null);
  const url = pictureShown(src, { show, failed: failed !== null && failed === src });
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
      ) : null}
    </span>
  );
}
