// What the extension's pages know of the link to the app: read from storage.local (the background writes it) and followed as
// it changes, so the code appears in the panel and the panel turns into the helper view the moment the app approves.

import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { LINK_KEY, createLinkStore, type AgentLink, type AgentLinkRequest, type LinkStore } from './agentLink';
import { UNREACHABLE } from './pageClient';

/** Null until storage has answered once. */
export function useAgentLink(store?: Pick<LinkStore, 'readLink'>): AgentLink | null {
  const source = useMemo(() => store ?? createLinkStore(), [store]);
  const [link, setLink] = useState<AgentLink | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      source
        .readLink()
        .then((l) => {
          if (live) setLink(l);
        })
        .catch(() => {
          if (live) setLink({ status: 'unpaired', notice: null });
        });
    };
    read();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      // The token is read with the link ("paired" needs it), so a change to either is a reason to read again.
      if (area === 'local' && (LINK_KEY in changes || 'agentToken' in changes)) read();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, [source]);
  return link;
}

/** What a page does about the link: ask the background. Each resolves to a sentence when it failed, null when it worked. */
export interface AgentLinkActions {
  connect(): Promise<string | null>;
  disconnect(): Promise<string | null>;
}

async function ask(request: AgentLinkRequest): Promise<string | null> {
  try {
    const reply = (await browser.runtime.sendMessage(request)) as { ok?: boolean; error?: string } | undefined;
    return reply?.ok ? null : (reply?.error ?? UNREACHABLE);
  } catch {
    return UNREACHABLE;
  }
}

export const realAgentLinkActions: AgentLinkActions = {
  connect: () => ask({ type: 'agentConnect' }),
  disconnect: () => ask({ type: 'agentDisconnect' }),
};
