/** Shape written by POST /api/bridge and read by the dashboard. */

export type BridgeEnvelope = {
  at: string;
  body: {
    kind?: string;
    bundles?: unknown[];
    exportedAt?: number;
  };
};

export function wrapBridgeBody(body: unknown, at: string): BridgeEnvelope {
  return { at, body: body as BridgeEnvelope['body'] };
}

export function bridgeSummary(wrapped: BridgeEnvelope): { at: string; bundleCount: number; kind: string | null } {
  const bundles = wrapped.body?.bundles;
  return {
    at: wrapped.at,
    bundleCount: Array.isArray(bundles) ? bundles.length : 0,
    kind: typeof wrapped.body?.kind === 'string' ? wrapped.body.kind : null,
  };
}