// The chip's side of the step 7 messages. The shapes are lib/messages.ts's (the worker's); this file only checks
// what comes back, because a reply crosses a message boundary and may be anything.

import type { BundleView, ChipSetting, OpenThisPageReply, Reply } from '../../lib/messages';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * The data of a worker reply. The worker answers every message with a Reply ({ ok: true, data } or
 * { ok: false, error }); a refusal, an error or anything else is undefined.
 */
export function dataOf(reply: unknown): unknown {
  return isObject(reply) && (reply as Partial<Reply>).ok === true ? reply.data : undefined;
}

/** The setting a worker message carries, or null when it is not a chipSetting message. */
export function chipSettingOf(message: unknown): ChipSetting['show'] | null {
  return isObject(message) && message.type === 'chipSetting' && typeof message.show === 'boolean' ? message.show : null;
}

/** True for a bundle PageView the chip can show (the data of a pageSeen reply). `off` and `none` are not. */
export function isBundleView(v: unknown): v is BundleView {
  if (!isObject(v) || v.kind !== 'bundle') return false;
  if (typeof v.parts !== 'number' || typeof v.lookupParts !== 'number' || typeof v.questionStored !== 'boolean') return false;
  if (!isObject(v.row)) return false;
  const e = v.row.estimate;
  if (e !== null && !(isObject(e) && Number.isFinite(e.profit) && Number.isFinite(e.roi))) return false;
  const q = v.question;
  return q === null || (isObject(q) && (q.choices === undefined || Array.isArray(q.choices)));
}

/** True only for openThisPage data that says the side panel opened. Anything else (no reply, an error) is "could not open". */
export function didOpen(data: unknown): boolean {
  return isObject(data) && (data as Partial<OpenThisPageReply>).opened === true;
}
