import { useState, type ReactNode } from 'react';
import type { AiSuggestion, FollowUp, FollowUpStep, Quote as Quote_, ReviewBrief, ReviewQuestion, SettledPart } from '../api/types';
import { SourceLink } from '../components/Source';
import { Spinner } from '../components/States';
import { Tag } from '../components/Tag';
import { money } from '../lib/format';
import { plainReason } from '../lib/questionWords';
import { ownerCheck } from '../lib/reviewBrief';
import { checkedLines, settledLines, groupBySource, stepSource, suggestionChip } from './reviewModel';
import './ReviewCard.css';

/** What the chip on the card says, by the brief's state; no chip when there is nothing to label. */
const CHIP: Record<ReviewBrief['state'], { label: string; tone: 'verified' | 'attention' | 'neutral' } | null> = {
  verified: { label: 'Verified', tone: 'verified' },
  not_verified: { label: 'Suggested, not verified', tone: 'attention' },
  cannot_tell: { label: 'AI could not tell', tone: 'neutral' },
  none: null,
};

/** A small source link the way the card writes it: the label and an arrow, opening the page. */
function Where({ label, url }: { label: string; url?: string | null }) {
  return (
    <SourceLink source={{ label, url: url ?? null }}>
      {label} <span aria-hidden="true">↗</span>
    </SourceLink>
  );
}

/**
 * The decision card: one box with the state, the suggestion as its largest text, Why in at most three short lines, and
 * the one thing to Check. Everything else the question holds is in Details. A suggestion is the AI's, never the owner's
 * answer, and the chip says whether the code could confirm it (HAX G10, G11; PAIR explainability).
 */
export function DecisionCard({ brief, id, fromAi, followUp, note, settled = [], unsettled = [] }: { brief: ReviewBrief; id: string; fromAi: boolean; followUp?: FollowUp; note?: ReactNode; settled?: SettledPart[]; unsettled?: string[] }) {
  const chip = CHIP[brief.state];
  const first = brief.reasons[0];
  // The app has been through this and could not settle it: the sentence says what is still missing, in the words the
  // brief gives (why it is asked, when the AI said nothing), so he is asked only what the app could not find.
  const gaveUp = followUp?.state === 'gave_up' && brief.state === 'none';
  const sentence = brief.state === 'cannot_tell' || gaveUp;
  const ours = ownerCheck(brief);
  const checked = followUp && (followUp.state === 'done' || followUp.state === 'gave_up') ? followUp.tried : [];
  return (
    <section className={`card card-${brief.state}`} id={id} aria-label="Suggested answer">
      {chip ? (
        <p className="card-chip">
          <Tag tone={chip.tone}>{chip.label}</Tag>
          {fromAi && brief.state !== 'cannot_tell' ? <span className="card-by">AI suggestion</span> : null}
        </p>
      ) : null}

      {sentence ? (
        <p className="card-main card-sentence">{first?.text ?? 'The page does not settle this.'}</p>
      ) : brief.suggestion ? (
        <p className="card-main" title={brief.suggestion}>
          {brief.suggestion}
        </p>
      ) : (
        <p className="card-main card-sentence card-quiet">No suggestion yet.</p>
      )}

      {unsettled.length > 0 ? (
        <p className="card-unsettled">
          <span>Still to settle:</span>
          {unsettled.map((m) => (
            <Tag key={m} tone="neutral">
              <span className="code">{m}</span>
            </Tag>
          ))}
        </p>
      ) : null}

      <Settled parts={settled} />

      {checked.length > 0 ? (
        <div className="card-part">
          <p className="card-label">What the app checked</p>
          <Checked tried={checked} />
        </div>
      ) : null}

      {brief.reasons.length > 0 && !sentence ? (
        <div className="card-part">
          <p className="card-label">Why</p>
          <ul className="card-why">
            {brief.reasons.map((r, i) => (
              <li key={i}>
                {r.text}
                {r.sourceLabel ? (
                  <>
                    {' '}
                    <Where label={r.sourceLabel} url={r.url} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {/* Only a call that needs a person: a page the app can read, it reads (checkWho). */}
      {ours ? (
        <div className="card-part card-check">
          <p className="card-label">{brief.state === 'cannot_tell' ? 'Next' : 'Check'}</p>
          <p>
            {ours.text}
            {ours.linkLabel ? (
              <>
                {' '}
                <Where label={ours.linkLabel} url={ours.url} />
              </>
            ) : null}
          </p>
        </div>
      ) : null}
      {note ? <div className="card-part card-note">{note}</div> : null}
    </section>
  );
}

/** What Home Depot's own pages confirmed, one line each: the model, what it is, and the page. The rest are in Details. */
function Settled({ parts }: { parts: SettledPart[] }) {
  if (parts.length === 0) return null;
  const { shown, rest } = settledLines(parts);
  return (
    <div className="card-part">
      <p className="card-label">Confirmed by Home Depot</p>
      <ul className="card-why card-settled">
        {shown.map((p) => (
          <li key={p.model}>
            <span className="code">{p.model}</span> {p.what}
            {p.url ? (
              <>
                {' '}
                <Where label="Home Depot" url={p.url} />
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {rest.length ? <p className="card-more">{rest.length} more in Details</p> : null}
    </div>
  );
}

/**
 * What the app did on its own, one line each: what it did, what came of it, and where, when it has an address. At most
 * CHECKED_VISIBLE lines; the rest are in Details.
 */
function Checked({ tried }: { tried: FollowUpStep[] }) {
  const { shown, rest } = checkedLines(tried);
  return (
    <>
      <ul className="card-why card-checked">
        {shown.map((t, i) => (
          <li key={i}>
            {t.what} — {t.result}
            {t.url ? (
              <>
                {' '}
                <Where label={stepSource(t.url)} url={t.url} />
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {rest.length ? <p className="card-more">{rest.length} more in Details</p> : null}
    </>
  );
}

/**
 * The card while the app is still working on the question: neutral, never a suggestion. What it is doing now with the
 * spinner, and what it has tried so far. He can answer early; the choices below say so.
 */
export function WorkingCard({ followUp, id, chromeClosed = false }: { followUp: FollowUp; id: string; chromeClosed?: boolean }) {
  const doing = followUp.doing ?? (followUp.state === 'queued' ? 'Waiting to start' : 'Checking');
  return (
    <section className="card card-working" id={id} aria-label="The app is working on this" aria-busy="true">
      <p className="card-chip">
        <Tag tone="neutral">Working on it</Tag>
        <span className="card-by">The app</span>
      </p>
      <p className="card-doing" role="status">
        <Spinner size={14} />
        <span>{doing}</span>
      </p>
      {chromeClosed ? <p className="card-hint">Open Chrome so the app can read these pages.</p> : null}
      {followUp.tried.length > 0 ? (
        <div className="card-part">
          <p className="card-label">What the app has checked so far</p>
          <Checked tried={followUp.tried} />
        </div>
      ) : null}
    </section>
  );
}

// "Details" stays as he left it for the rest of the session: a question he opened it on opens it on the next one too.
const DETAILS_KEY = 'splitFinder.reviewDetailsOpen';
let detailsOpen: boolean | null = null;

function readDetailsOpen(): boolean {
  if (detailsOpen !== null) return detailsOpen;
  try {
    detailsOpen = typeof sessionStorage !== 'undefined' && sessionStorage.getItem(DETAILS_KEY) === '1';
  } catch {
    detailsOpen = false;
  }
  return detailsOpen;
}

function rememberDetailsOpen(open: boolean): void {
  detailsOpen = open;
  try {
    sessionStorage.setItem(DETAILS_KEY, open ? '1' : '0');
  } catch {
    // remembered for this window only
  }
}

/** Quotes grouped by where they were found: the source once, as a link, then each line. Nothing is dropped. */
function SourceGroups({ quotes }: { quotes: Quote_[] }) {
  return (
    <>
      {groupBySource(quotes).map((g) => (
        <div className="detail-group" key={`${g.source.label}|${g.source.url ?? ''}`}>
          <p className="detail-source">
            <Where label={g.source.label} url={g.source.url} />
          </p>
          <ul className="detail-quotes">
            {g.texts.map((t, i) => (
              <li key={i}>
                <q>{t}</q>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/**
 * Everything the question holds that the card does not say, behind one disclosure: the AI's own reason, what the code
 * checked, why the question was asked and its technical note, the quotes by source, the page's own lines, and the cost.
 * Collapsed until he opens it, and then it stays open for the session.
 */
export function Details({ q, s }: { q: ReviewQuestion; s: AiSuggestion | null }) {
  const [open, setOpen] = useState(readDetailsOpen);
  const why = plainReason(q.reason, { brand: q.bundle.brand, model: q.bundle.model });
  const chip = s ? suggestionChip(s) : null;
  const checked = chip?.why ?? null;
  const code = s?.notVerified?.trim() && s.notVerified.trim() !== checked ? s.notVerified.trim() : null;
  return (
    <details
      className="details"
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        if (now !== open) {
          setOpen(now);
          rememberDetailsOpen(now);
        }
      }}
    >
      <summary>Details</summary>
      <div className="detail-body">
        {settledLines(q.settledParts ?? []).rest.length > 0 ? (
          <section className="detail-sec">
            <h3>Also confirmed by Home Depot</h3>
            <ul className="detail-quotes">
              {settledLines(q.settledParts ?? []).rest.map((p) => (
                <li key={p.model}>
                  <span className="code">{p.model}</span> {p.what}
                  {p.url ? (
                    <>
                      {' '}
                      <Where label="Home Depot" url={p.url} />
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {q.followUp && q.followUp.tried.length > 0 ? (
          <section className="detail-sec">
            <h3>What the app checked</h3>
            <ul className="detail-quotes">
              {q.followUp.tried.map((t, i) => (
                <li key={i}>
                  {t.what} — {t.result}
                  {t.url ? (
                    <>
                      {' '}
                      <Where label={stepSource(t.url)} url={t.url} />
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {s ? (
          <section className="detail-sec">
            <h3>The AI’s reason</h3>
            {s.status !== 'cannot_tell' && s.answer ? (
              <p>
                <span className="muted">It answered: </span>
                <span className="code">{s.answer}</span>
              </p>
            ) : null}
            <p>{s.reason ? s.reason : 'The AI gave no reason.'}</p>
          </section>
        ) : null}
        {checked ? (
          <section className="detail-sec">
            <h3>What the code checked</h3>
            <p>{checked}</p>
            {code ? <p className="detail-tech code">{code}</p> : null}
          </section>
        ) : null}
        <section className="detail-sec">
          <h3>Why it was asked</h3>
          <p>{why.text}</p>
          {why.technical ? <p className="detail-tech code">{why.technical}</p> : null}
        </section>
        {s ? (
          <section className="detail-sec">
            <h3>What the AI quoted</h3>
            {s.quotes.length ? <SourceGroups quotes={s.quotes} /> : <p className="muted">The AI quoted no source text.</p>}
          </section>
        ) : null}
        {q.evidence.length ? (
          <section className="detail-sec">
            <h3>What the pages say</h3>
            <SourceGroups quotes={q.evidence} />
          </section>
        ) : null}
        {s && s.costUsd > 0 ? (
          <section className="detail-sec">
            <h3>Cost</h3>
            <p>
              AI cost <span className="fig">{money(s.costUsd)}</span>
            </p>
          </section>
        ) : null}
      </div>
    </details>
  );
}
