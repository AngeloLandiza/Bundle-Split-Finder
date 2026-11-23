import { api, useAction, useApp, useResource } from '../api/hooks';
import type { PartResult, PurchaseView } from '../api/types';
import { Button, LinkButton } from '../components/Button';
import { Section } from '../components/Layout';
import { Page } from '../components/Page';
import { EmptyState, LoadError, LoadingState } from '../components/States';
import { SourceLink } from '../components/Source';
import { Tag } from '../components/Tag';
import { useUi } from '../components/ui';
import { boughtWords, partWords, progressWords, resultWords } from '../lib/outcomes';
import { plural, profit } from '../lib/format';
import './Bought.css';

/**
 * Bought (docs/decisions.md, "Outcomes"): the deals he recorded buying, newest first, each with what the estimate said when he
 * bought it (frozen) and what became of each part, as he recorded it. Estimates are labelled; realised figures say he recorded them.
 */
export function BoughtScreen() {
  const { navigate } = useApp();
  const ui = useUi();
  const [res, reload] = useResource(() => api.outcomes(), [], ['deals', 'activity']);
  const csv = useAction(api.downloadOutcomesCsv);
  const undo = useAction(api.undoOutcome);
  const d = res.data;
  // The newest change that can still be taken back: one sentence and its Undo, where he made it.
  const last = d?.entries.find((e) => e.undoable) ?? null;
  const sub = d ? `${plural(d.purchases.length, 'purchase', 'purchases')} · recorded by you` : undefined;
  return (
    <Page
      title="Bought"
      sub={sub}
      grouped
      actions={
        d && d.purchases.length ? (
          <Button variant="toolbar" glyph="download" busy={csv.busy} busyLabel="Preparing…" onClick={() => void csv.run()} title="Save what you bought and what became of it as a CSV file">
            Download CSV
          </Button>
        ) : null
      }
    >
      <div className="bought">
        {res.status === 'loading' ? <LoadingState label="Loading what you bought" /> : null}
        {res.status === 'error' && !d ? <LoadError error={res.error} onRetry={reload} /> : null}
        {d && d.purchases.length === 0 ? (
          <Section label="Bought">
            <EmptyState
              compact
              title="No purchases recorded yet"
              cause="When you buy a deal, open it in Deals and press I bought this. It is saved here with the estimate as it stood, so you can see later how far it was from what you made."
              action={<Button onClick={() => navigate({ screen: 'deals', id: null, view: 'buy-now' })}>Open the deals</Button>}
            />
          </Section>
        ) : null}
        {last || csv.error || undo.error ? (
          <p className="bought-said" role="status">
            {csv.error ?? undo.error ?? last?.sentence}
            {last && !csv.error && !undo.error ? (
              <>
                {' '}
                <LinkButton disabled={undo.busy} onClick={() => void undo.run(last.id)}>
                  Undo
                </LinkButton>
              </>
            ) : null}
          </p>
        ) : null}
        {d?.purchases.map((p) => (
          <PurchaseBlock key={p.id} p={p} onEdit={() => ui.openPurchase({ mode: 'edit', purchase: p })} onOpenDeal={() => navigate({ screen: 'deals', id: p.dealId })} />
        ))}
      </div>
    </Page>
  );
}

function PurchaseBlock({ p, onEdit, onOpenDeal }: { p: PurchaseView; onEdit: () => void; onOpenDeal: () => void }) {
  const r = p.result;
  const s = p.snapshot;
  const result = resultWords(r);
  return (
    <Section
      label={s.bundle.title}
      action={
        <Button size="sm" onClick={onEdit}>
          Change…
        </Button>
      }
      note={
        <>
          Frozen when you bought it ({new Date(s.takenAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}): {s.estimate ? `${profit(s.estimate.profit)} estimated profit` : 'no complete estimate'}. {s.basis}
        </>
      }
    >
      <div className="bought-head">
        <p className="bought-line">
          <span className="code">{s.bundle.model}</span> · {boughtWords(p)} · <span className="bought-progress">{progressWords(r)}</span>
          {s.buyNow ? (
            <>
              {' '}
              <Tag tone="buy">Flagged Buy now</Tag>
            </>
          ) : null}
        </p>
        {result ? <p className="bought-sub">{result}</p> : null}
        <p className="bought-sub">
          <LinkButton onClick={onOpenDeal}>Open the deal</LinkButton>
          {s.bundle.link ? (
            <>
              {' · '}
              <SourceLink source={{ label: 'Home Depot page', url: s.bundle.link }} />
            </>
          ) : null}
        </p>
      </div>
      <ul className="rows">
        {r.parts.map((part) => (
          <PartRow key={part.partId} p={p} part={part} />
        ))}
      </ul>
    </Section>
  );
}

function PartRow({ p, part }: { p: PurchaseView; part: PartResult }) {
  const ui = useUi();
  const hold = useAction(api.recordPart);
  const snap = p.snapshot.parts.find((x) => x.id === part.partId)!;
  return (
    <li className="bpart">
      <div className="bpart-main">
        <p className="bpart-title">
          <span className="code">{part.model}</span>
          {part.units > 1 ? <span className="bpart-units"> × {part.units}</span> : null}
        </p>
        <p className="bpart-sub">
          {snap.netEach !== null ? (
            <>
              Estimated net <span className="fig">{`$${snap.netEach.toFixed(2)}`}</span> each after fees (an estimate)
              {snap.listingLink ? (
                <>
                  {' · '}
                  <SourceLink source={{ label: 'Amazon listing', url: snap.listingLink }} />
                </>
              ) : null}
            </>
          ) : (
            'Not counted in the estimate'
          )}
        </p>
        <p className={part.status === 'open' ? 'bpart-state bpart-open' : 'bpart-state'}>{partWords(part)}</p>
        {hold.error ? (
          <p className="bpart-state" role="alert">
            {hold.error}
          </p>
        ) : null}
      </div>
      <div className="bpart-actions">
        <Button size="sm" aria-pressed={part.status === 'sold'} onClick={() => ui.openPart({ purchase: p, part, kind: 'sold' })}>
          {part.status === 'sold' ? 'Change sale…' : 'Sold for…'}
        </Button>
        <Button size="sm" aria-pressed={part.status === 'holding'} busy={hold.busy} busyLabel="Saving…" onClick={() => void hold.run(p.id, part.partId, { status: 'holding' })}>
          Still holding
        </Button>
        <Button size="sm" aria-pressed={part.status === 'returned'} onClick={() => ui.openPart({ purchase: p, part, kind: 'returned' })}>
          Returned / not sold…
        </Button>
      </div>
    </li>
  );
}
