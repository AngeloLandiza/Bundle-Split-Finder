import type { LinkStore } from '../../lib/agentLink';
import { AgentConnect } from '../../lib/AgentConnect';
import { realAgentLinkActions, useAgentLink, type AgentLinkActions } from '../../lib/useAgentLink';
import { Section } from './fields';

/** Step 13: pair this browser with the Split Finder app, or disconnect it. */
export function AgentSection({
  linkStore,
  actions = realAgentLinkActions,
  now,
}: {
  linkStore?: Pick<LinkStore, 'readLink'>;
  actions?: AgentLinkActions;
  now?: () => number;
}) {
  const link = useAgentLink(linkStore);
  return (
    <Section
      title="Split Finder app"
      help="Optional. The app runs the scans, holds your keys and sends its questions here to answer. While this browser is connected, scans, keys and AI are the app's; the settings below apply again when you disconnect."
    >
      {link ? <AgentConnect link={link} actions={actions} now={now} /> : null}
    </Section>
  );
}
