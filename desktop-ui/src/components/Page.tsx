import type { ReactNode } from 'react';
import type { KeyName } from '../api/types';
import { NoticeRegion, type NoticeItem } from './NoticeRegion';
import { Toolbar } from './Toolbar';
import './Page.css';

/**
 * A screen: its toolbar in the title bar, its one notice region, then the body. `grouped` sets the body on
 * the grouped ground with group boxes (Today, Activity, Settings); otherwise the body is the content
 * ground and fills the window (Deals, Review).
 */
export function Page({
  title,
  sub,
  actions,
  search,
  viewOptions,
  inspector = false,
  grouped = false,
  scanNotices = false,
  costNotice = true,
  keys,
  notices,
  children,
  bodyClass,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  search?: ReactNode;
  viewOptions?: ReactNode;
  inspector?: boolean;
  grouped?: boolean;
  /** Today and Deals show the scan-problem and outdated-helper banners. */
  scanNotices?: boolean;
  /** The cost warning (lib/costs.ts costNotice) shows on every screen but Costs itself, which says it in full. */
  costNotice?: boolean;
  /** The saved keys this screen works with: a rejected one among them is the banner (lib/notices.ts SCREEN_KEYS). */
  keys?: readonly KeyName[];
  /** What only the screen knows (Deals: parts waiting for a lookup); they take their place in the one notice region. */
  notices?: readonly NoticeItem[];
  children: ReactNode;
  bodyClass?: string;
}) {
  return (
    <div className="page">
      <Toolbar title={title} sub={sub} actions={actions} search={search} viewOptions={viewOptions} inspector={inspector} />
      <NoticeRegion scan={scanNotices} keys={keys} extra={notices} cost={costNotice} />
      <div className={`page-body${grouped ? ' page-body-grouped' : ' page-body-fill'}${bodyClass ? ` ${bodyClass}` : ''}`}>{children}</div>
    </div>
  );
}
