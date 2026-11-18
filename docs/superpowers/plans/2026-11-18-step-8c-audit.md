# Step 8c: the audit loop — catch matching failures on real scans and lock the fixes in

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** The owner (or the controller) can turn any real scan into a scored audit: the extension exports what it matched, a blind checker labels the right listings, a script scores the tool against the labels, and every labelled pair joins a corpus that `npm test` runs through the matcher forever.

**Owner, Nov 18:** "this scraper should be perfect and should have a way to catch and safely and accurately fix failures. maybe llm solution?" → controller's recommendation (an LLM checks, it never decides in the product) → "okay do the audit loop then".

**Spec:** CLAUDE.md (never guess; the key never leaves the extension; no network in default tests), docs/decisions.md (Matching), the validation harness (scripts/validate-cli.ts: `scoreCriterion6`, the labels format).

## Contract: the audit export (Task 1 produces, Task 2 consumes)
`split-finder-audit-<YYYY-MM-DD>.json`:
```
{ "kind": "split-finder-audit", "version": 1, "exportedAt": <ms>,
  "bundles": [ { "key", "itemId", "brand", "model", "title", "section", "split": string[] | null,
                 "parts": [ { "brand", "model", "qty", "asin": string | null, "grade": string | null, "source": string | null, "isKit": boolean } ] } ],
  "listings": [ ListingRecord as stored (asin, title, brand, model?, price, …) ],
  "matches":  [ MatchRecord as stored ],
  "answers":  [ answered ReviewItem as stored ],
  "questions": [ open ReviewItem (answer null) as stored ] }
```
Fix round 1 added `isKit` (what wantedFor asks of the part, from the scan's catalog) and `questions` (open items, whose candidates may be rows the scan never saved as listings) to **version 1**. Both are additive: `prepare` reads a version 1 file without them.
Never the key, never settings. Parts are the report's rows (primary way to sell).

## Task 1 (Sonnet): the export
Worker message `exportAudit` → the JSON above; Settings → Your data gains **Export for audit** (downloads it, same pattern as the existing exports); tests (worker shape on the recorded replay store; no key in the output; the button).

## Task 2 (Opus): the audit CLI, the corpus and its test
- `npm run audit -- prepare <export.json>` writes `audit/<date>/blind.json` (bundles, parts, and per part the candidate listings: every saved listing whose title names the part's model as a whole token, its RYOBI B twin allowed, plus the chosen listing — with no grade, no chosen ASIN, no source) and `audit/<date>/tool.json` (the tool's choices). `audit/` is gitignored except what `score` promotes.
- `npm run audit -- score <dir>` reads `labels.json` (the validation labels format) and writes `failures.md`: wrong matches (chosen ASIN not in `correct`), missed listings (a correct listing among the candidates, tool none/review), and appends every labelled (part, listing, correct?) pair to `fixtures/audit/corpus.json` (deduped by part+ASIN; each with its source audit and note).
- `core/test/match-corpus.test.ts`: for every corpus pair, the matcher's grade of that listing for that part: a pair labelled not-the-part must never grade probable or better; a pair labelled the part must grade at least review (never silently none). Seed the corpus from the validation labels and responses (150 parts). Failing pairs at the time of seeding are listed in the report and marked `known` with a reason, so the test passes and the list shows what is left to fix (the four misses are being fixed on this branch in parallel).
- `docs/audit.md`: how to run an audit end to end, and `docs/audit-checker.md`: the blind checker's instructions (the rules used on Nov 18: same brand; model as a whole token, RYOBI B twin allowed; new and alone; a kit part is the kit; uncertain kept separate), written so a Claude Code subagent or any LLM can be given it verbatim.

## Rules
No searches; no network in tests; never read .env. Typecheck, npm test, e2e pass.

## Where this stands (2026-11-18)

Done on main. The audit loop: Export for audit (Sonnet; with `isKit` and open questions), `npm run audit -- prepare | score | seed-validation` (Opus), `fixtures/audit/corpus.json` seeded with the validation's 279 labelled pairs, and `core/test/match-corpus.test.ts` grading every pair with the scan's own `grade(wantedFor(…), row)`; docs/audit.md and docs/audit-checker.md.

What it caught and what was fixed (each with an Opus review and an independent re-check):
- Step 8b, the four misses: PCL265B, PBP004, A986501, PBP2003 now reach the owner as review questions (root causes: "Battery and Charger NOT Included" read as a kit; "TTI Ryobi"; a part that is itself a set or a pack). One fix round kept "Replacement"/OEM titles rejected, read "not included" only with and/&/or, and guarded both written forms of a tool-only model.
- The corpus's first run: DCK240C2 sold with a saw, a bit set or a mechanics set graded probable as the kit. Now review (`KIT_WITH_EXTRAS`); one fix round closed whole-word, every-joining-word, extra-battery and "70PC" gaps and two false triggers found on the recordings.
- Throughout: the 216 probable-or-better recorded pairs unchanged; the validation replay unchanged (78 of 78 probable right, no wrong match); no known pair left in the corpus.

Open: the first audit of a real scan (the owner exports; the controller runs the blind checker with docs/audit-checker.md); remaining documented gaps in decisions.md.
