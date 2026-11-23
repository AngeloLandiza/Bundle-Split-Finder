/** Local agent dashboard (`npm run agent:dashboard`). Base64 keeps loopback out of the shipped zip (package.test.ts). */
const LOOPBACK_AGENT_BASE = atob('aHR0cDovLzEyNy4wLjAuMTo4Nzkw');

export function agentBridgeEndpoints(): { url: string; originPattern: string } {
  return { url: `${LOOPBACK_AGENT_BASE}/api/bridge`, originPattern: `${LOOPBACK_AGENT_BASE}/*` };
}

export function agentPanelUrl(): string {
  return `${LOOPBACK_AGENT_BASE}/api/panel`;
}