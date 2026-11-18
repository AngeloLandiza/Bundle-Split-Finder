import { useEffect, useRef, useState } from 'react';
import type { BundleRow } from '@core/scan/types';

/** "A", "A and B", "A, B and C". */
function listOf(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Copy ASINs for one bundle's parts: Detail and the This page tab share it. `copied` is the sentence to say for two
 * seconds after a copy (it names the parts that have no ASIN), `copyFailed` is true when the clipboard refused.
 */
export function useCopyAsins(row: BundleRow | null) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const asins = row ? row.parts.map((p) => p.asin).filter((a): a is string => a !== null) : [];
  const missingAsin = row ? row.parts.filter((p) => p.asin === null).map((p) => p.model) : [];

  const copy = () => {
    if (asins.length === 0) return;
    setCopyFailed(false);
    navigator.clipboard
      .writeText(asins.join(' '))
      .then(() => {
        setCopied(
          missingAsin.length === 0
            ? 'Copied'
            : `Copied ${asins.length} ${asins.length === 1 ? 'ASIN' : 'ASINs'}. ${listOf(missingAsin)} ${missingAsin.length === 1 ? 'has' : 'have'} no ASIN.`,
        );
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => setCopyFailed(true));
  };

  return { asins, copy, copied, copyFailed };
}
