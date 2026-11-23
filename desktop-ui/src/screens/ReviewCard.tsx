import { useState } from 'react';
import type { AiSuggestion, Quote as Quote_, ReviewBrief, ReviewQuestion } from '../api/types';
import { SourceLink } from '../components/Source';
import { Tag } from '../components/Tag';
import { money } from '../lib/format';
import { plainReason } from '../lib/questionWords';
import { groupBySource, suggestionChip } from './reviewModel';
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
export function DecisionCard({ brief, id, fromAi }: { brief: ReviewBrief; id: string; fromAi: boolean }) {
  const chip = CHIP[brief.state];
  const first = brief.reasons[0];
  return (
    <section className={`card card-${brief.state}`} id={id} aria-label="Suggested answer">
      {chip ? (
        <p className="card-chip">
          <Tag tone={chip.tone}>{chip.label}</Tag>
          {fromAi && brief.state !== 'cannot_tell' ? <span className="card-by">AI suggestion</span> : null}
        </p>
      ) : null}

      {brief.state === 'cannot_tell' ? (
        <p className="card-main card-sentence">{first?.text ?? 'The page does not settle this.'}</p>
      ) : brief.suggestion ? (
        <p className="card-main" title={brief.suggestion}>
          {brief.suggestion}
        </p>
      ) : (
        <p className="card-main card-sentence card-quiet">No suggestion yet.</p>
      )}

      {brief.reasons.length > 0 && brief.state !== 'cannot_tell' ? (
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
      {brief.check ? (
        <div className="card-part card-check">
          <p className="card-label">{brief.state === 'cannot_tell' ? 'Next' : 'Check'}</p>
          <p>
            {brief.check.text}
            {brief.check.linkLabel ? (
              <>
                {' '}
                <Where label={brief.check.linkLabel} url={brief.check.url} />
              </>
            ) : null}
          </p>
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
