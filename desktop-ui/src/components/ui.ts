// The window's own state, apart from the agent's: whether the inspector shows and how wide it is, the
// look (appearance, accent, density), and opening the welcome sheet again. App provides it.

import { createContext, useContext } from 'react';
import type { Look } from '../lib/appearance';
import type { BogoTarget } from './BogoSheet';
import type { ConfirmTarget } from './ConfirmPriceSheet';

export interface UiValue {
  inspectorShown: boolean;
  setInspectorShown: (shown: boolean) => void;
  inspectorWidth: number;
  setInspectorWidth: (px: number) => void;
  look: Look;
  setLook: (look: Look) => void;
  /** Opens the welcome sheet at the first step still open. */
  openSetup: () => void;
  /** Cmd+K: the command palette. */
  openPalette: () => void;
  /** Cmd+/: the keyboard shortcuts sheet. */
  openShortcuts: () => void;
  /** The Confirm a price sheet for one part of a deal; a sheet over the window, so App holds it. */
  openConfirmPrice: (target: ConfirmTarget) => void;
  /** The BOGO sheet for one deal: choose the free tool, or mark the deal as a BOGO promotion. */
  openBogo: (target: BogoTarget) => void;
}

export const UiContext = createContext<UiValue | null>(null);

export function useUi(): UiValue {
  const v = useContext(UiContext);
  if (!v) throw new Error('useUi outside UiContext');
  return v;
}

export const INSPECTOR_MIN = 300;
export const INSPECTOR_MAX = 640;
export const INSPECTOR_DEFAULT = 380;

export function clampInspector(px: number): number {
  return Math.round(Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, px)));
}
