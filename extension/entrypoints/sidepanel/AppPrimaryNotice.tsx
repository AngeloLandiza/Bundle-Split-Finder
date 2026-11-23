import { useEffect, useState } from 'react';
import { appHomeUrl } from '../../lib/appPrimaryUi';
import { getAppPrimaryUi } from '../../lib/prefs';

declare const __SPLIT_FINDER_HELPER__: boolean;

/** P5: when the native app is primary, point owners at the app instead of duplicating the full panel UX. */
export function AppPrimaryNotice() {
  const [primary, setPrimary] = useState(false);
  useEffect(() => {
    if (typeof __SPLIT_FINDER_HELPER__ === 'undefined' || !__SPLIT_FINDER_HELPER__) return;
    void getAppPrimaryUi().then(setPrimary);
  }, []);
  if (!primary) return null;
  return (
    <p className="note" role="status">
      Split Finder runs in the app. This panel is for quick checks. Scan, settings and deals live in the app dashboard.
      {' '}
      <a href={appHomeUrl()} target="_blank" rel="noreferrer">
        Open dashboard
      </a>
      .
    </p>
  );
}