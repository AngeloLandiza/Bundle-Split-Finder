import { browser } from 'wxt/browser';

import { agentBridgeEndpoints } from './agentBridge';

const APP_HOME = agentBridgeEndpoints().url.replace(/\/api\/bridge$/, '/');

/** When the app is primary, the toolbar action must not hijack to the side panel. */
export async function applyToolbarPanelBehavior(primary: boolean, compactHelperPanel: boolean): Promise<void> {
  if (typeof browser.sidePanel?.setPanelBehavior !== 'function') return;
  const openOnAction = !primary || compactHelperPanel;
  await browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: openOnAction }).catch(() => {});
}

export function appHomeUrl(): string {
  return APP_HOME;
}