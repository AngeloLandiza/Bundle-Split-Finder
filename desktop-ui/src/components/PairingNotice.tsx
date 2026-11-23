import { useApp } from '../api/hooks';
import { Button } from './Button';
import { Notice } from './States';

/** "482913" read the way it is shown in Chrome: "482 913". */
export function spacedCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/**
 * A request from Chrome to connect, one calm band under the header on every screen (design.md, Desktop app >
 * States): the code to compare with the one Chrome shows, then Allow or Deny. Nothing connects until he allows it.
 */
export function PairingNotices() {
  const { pairing, online } = useApp();
  if (!online || pairing.requests.length === 0) return null;
  return (
    <>
      {pairing.requests.map((r) => (
        <Notice
          key={r.requestId}
          tone="attention"
          title="Chrome wants to connect."
          action={
            <>
              <Button variant="primary" size="sm" busy={pairing.busyId === r.requestId} busyLabel="Allowing…" onClick={() => void pairing.decide(r.requestId, true)}>
                Allow
              </Button>
              <Button size="sm" disabled={pairing.busyId === r.requestId} onClick={() => void pairing.decide(r.requestId, false)}>
                Deny
              </Button>
            </>
          }
        >
          Code <span className="fig">{spacedCode(r.code)}</span>. Allow it only if Chrome shows the same code.
          {pairing.error ? <span role="alert"> {pairing.error}</span> : null}
        </Notice>
      ))}
    </>
  );
}
