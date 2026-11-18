// The two messages the chip sends to the service worker (step 7 contract). They are declared here so the
// content script does not depend on lib/messages.ts, which the worker side owns; the shapes match it.

import type { ProductPage } from '@core/hdPage';
import type { PageView } from '@core/scan/pageView';

/**
 * The page the owner has open, read from its own embedded data. The worker replies with a PageView, or
 * `{ kind: 'off' }` while "Show the chip on Home Depot pages" is off (no chip, like `none`).
 */
export interface PageSeenRequest {
  type: 'pageSeen';
  page: ProductPage;
}

/** The owner clicked the chip. The worker opens the side panel on This page and replies OpenThisPageReply. */
export interface OpenThisPageRequest {
  type: 'openThisPage';
}

export interface OpenThisPageReply {
  opened: boolean;
}

export type ChipRequest = PageSeenRequest | OpenThisPageRequest;

/** What the worker sends a Home Depot tab when the owner changes the setting. */
export interface ChipSettingMessage {
  type: 'chipSetting';
  show: boolean;
}

/** The setting a worker message carries, or null when it is not a chipSetting message. */
export function chipSettingOf(message: unknown): boolean | null {
  return isObject(message) && message.type === 'chipSetting' && typeof message.show === 'boolean' ? message.show : null;
}

export type BundleView = Extract<PageView, { kind: 'bundle' }>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** True for a bundle PageView the chip can show. The reply crosses a message boundary, so its shape is checked. */
export function isBundleView(v: unknown): v is BundleView {
  if (!isObject(v) || v.kind !== 'bundle') return false;
  if (typeof v.parts !== 'number' || typeof v.lookupParts !== 'number') return false;
  if (!isObject(v.row)) return false;
  const e = v.row.estimate;
  if (e !== null && !(isObject(e) && Number.isFinite(e.profit) && Number.isFinite(e.roi))) return false;
  const q = v.question;
  return q === null || (isObject(q) && (q.choices === undefined || Array.isArray(q.choices)));
}

/** True only for a reply that says the side panel opened. Anything else (no reply, an error) is "could not open". */
export function didOpen(reply: unknown): boolean {
  return isObject(reply) && reply.opened === true;
}
