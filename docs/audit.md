# The audit loop

An audit turns a real scan into a score of the matcher, and every pair it labels into a permanent test.
It spends **no searches**: it works only from the extension's export and the files below. A model checks
the matches; it never decides one in the product (CLAUDE.md rule 4).

```
scan (extension)  ->  Export for audit  ->  npm run audit -- prepare  ->  blind checker  ->  npm run audit -- score
                                             blind.json, tool.json        labels.json        failures.md, corpus.json
```

## 1. Export the scan

In the extension: Settings, Your data, **Export for audit**. It downloads
`split-finder-audit-<YYYY-MM-DD>.json`: the bundles with their parts (the primary way to sell), the saved
Amazon listings, the match records and the answered review items. It never holds the key or the settings;
`prepare` refuses a file that names either.

## 2. Prepare

    npm run audit -- prepare ~/Downloads/split-finder-audit-2026-11-20.json

writes, under `audit/2026-11-20/` (gitignored):

- `blind.json`, for the checker: per bundle part, every saved listing whose title names the part's model
  as a whole token (RYOBI: with or without its tool-only B), the listings of an answered or open match question,
  and the listing the tool chose, in ASIN order. No grade, no chosen ASIN, no source.
- `tool.json`, never shown to the checker: per part, the tool's status, listing, grade and source, and
  where each candidate's row came from.

A second export of the same day refuses to overwrite the first; pass `--out audit/2026-11-20b`.

## 3. Label, blind

Give a checker `docs/audit-checker.md` verbatim and the path of `blind.json`, nothing else. From Claude
Code, a subagent with a prompt like:

> Follow docs/audit-checker.md exactly. The audit folder is audit/2026-11-20. Read only
> audit/2026-11-20/blind.json and write audit/2026-11-20/labels.json. Report counts and the hardest calls.

The checker must not see `tool.json`, `failures.md`, the corpus, or test output. The main session reads
its report, not its labels, before scoring.

## 4. Score

    npm run audit -- score audit/2026-11-20

writes `audit/2026-11-20/failures.md`, every listing linked to Amazon and every bundle to Home Depot:

- **Wrong matches**: the tool chose a listing that is not among the correct ones.
- **Chosen listings the checker could not settle**: the choice is under `uncertain`; a person decides.
- **Missed listings**: a correct listing exists, and the tool left the part with none or in review.
- Parts not looked up, and parts with no label.
- Pairs the matcher grades against the label, label conflicts with the corpus, and labelled listings the
  corpus cannot hold.

It also adds every labelled (part, listing) pair to `fixtures/audit/corpus.json`, one per part and ASIN:

- a new pair is added; an `uncertain` pair takes a later certain label;
- a certain label is never replaced: a different one is listed as a conflict for a person to settle in
  the corpus by hand;
- a pair the matcher fails today is added with `known` set to the reason.

Only a saved listing becomes a pair, because only it is the search row a scan graded, with its brand field.
A listing known only from a match question or as the tool's choice is listed, not added.

## 5. Commit and fix

Read `failures.md`. Commit `fixtures/audit/corpus.json` (the audit folder stays local).
`core/test/match-corpus.test.ts` then grades every pair on every `npm test`, with the scan's own grading
(`grade` over `wantedFor`):

- a pair labelled not the part must never grade probable or better;
- a pair labelled the part must grade at least review (never rejected silently);
- `uncertain` pairs are not tested until a person settles them;
- a `known` pair must still fail. The commit that fixes it removes its `known` mark, or the test says so.

A fix follows CLAUDE.md: a test on the real example first, and no rule that turns an ambiguous case into a
confident one.

## The validation seed

    npm run audit -- seed-validation

adds the validation set's pairs (fixtures/validation: the recorded responses, the blind labels of
Nov 18, and the replayed run's choices). For each labelled part: every recorded row whose title names its
model, the labels' listings and the tool's choice. This holds rows with an empty brand field, which an
export cannot (see below). `core/test/audit-cli.test.ts` checks the corpus still holds them.

## Try it on the sample

`fixtures/audit/split-finder-audit-2026-11-18.json` is a hand-made export, filled from the validation
run's replay; its labels are the validation labels:

    npm run audit -- prepare fixtures/audit/split-finder-audit-2026-11-18.json --out audit/sample
    cp fixtures/validation/labels-2026-11-18.json audit/sample/labels.json
    npm run audit -- score audit/sample

It finds the four listings the validation run missed (PCL265B, PBP004, A986501, PBP2003) and adds nothing
to the corpus, which already holds those pairs.

## Limits

- The extension saves an Amazon row only when its brand field is DEWALT or RYOBI, so a listing with an
  empty brand field (B0BL8BC8MF "Ryobi PCL265 …") never reaches an export unless a match question showed
  it, and even then it does not become a pair.
- Exports made before step 8c fix round 1 do not say whether the scan asked for a part as a kit. Such a pair is graded as for
  a part the catalog does not know (`isKit: null`); DEWALT `DCK…` is a kit either way. Newer exports carry `isKit` on every part.
- Export version 1 also carries `questions`, the open review items. `prepare` shows the candidates of an open match
  question to the checker like those of an answered one (title, price, reviews; never the reasons or a grade), so a row
  with an empty brand field that the scan never saved as a listing can still be labelled. Older files lack the field.
- Only the primary way to sell is exported: the items of a split kit option are not audited.

## Checking the app's own work

The audit above scores the matcher against labels. This is the second line for what the app has already decided: it reads
the stored deals, not the rules, so it catches a wrong confirmation whatever rule made it (the Nov 24 case: a $389 backpack
confirmed for a $39.99 adaptor plate by Amazon's wrong catalog part number). The checks, their thresholds and what each was
measured on are in docs/decisions.md ("Checking the app's own work"); the code is `core/src/audit/sanity.ts`.

In the app, the checks run every time the deals are written. A deal with a `hold` is never Buy now; its row says
"Needs a look: <why>" and the inspector lists each finding with its Home Depot and Amazon links. **This is right** is
remembered for that listing; **Wrong listing** withdraws the match and the listing is never chosen for the part again.

On any data set, free and offline:

    npm run audit:sanity -- fixtures/e2e-2026-11-23/after-scan5
    npm run audit:sanity -- ~/Downloads/split-finder-audit-2026-11-24.json      # Settings, Data, Export audit file
    npm run audit:sanity -- <export> --all                                     # also what the owner marked right

It prints one row a finding (severity, check, deal, part, listing, why) and the links of each hold, and exits 1 when
anything holds, so a script or a person sees it before the owner does. When the owner catches a wrong listing by eye that
this missed, record it as a fixture (as `fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json`), add a test, and add a
check only if the recorded data shows it would not flag right answers.

`core/test/sanity-mutation.test.ts` is the red team for the rules: real confirmed records corrupted one thing at a time
(another product's listing, a swapped title, a price times ten, a 2-pack) and the report rebuilt; none that a buy could rest
on may come out confirmed and unflagged.

A model's second opinion is a harness, not run by tests: `npm run redteam:listings -- <dir or export>` prints how many
confirmed listings it would ask about and the estimated cost, and calls nothing. With `--spend` (and `--max-cost`) it asks
the listing judge's question per listing and lists where the model disagrees, for a person to look at. It never decides and
changes nothing; the main session decides whether to spend on it.
